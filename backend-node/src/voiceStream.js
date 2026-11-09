// The voice gateway: Twilio Media Streams <-> Gnani speech <-> your RAG service.
//
//   Twilio  --(8 kHz mu-law audio, over a WebSocket)-->  here  --> Gnani STT --> text
//   text --> Python /ask (RAG + Groq) --> answer --> Gnani TTS --> mu-law --> Twilio
//
// One CallSession per phone call. Callers are assumed to be polite and to speak after
// the agent has finished: anything heard while the agent is thinking or speaking is ignored.

import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { GnaniStt } from "./gnani/sttClient.js";
import { GnaniTts } from "./gnani/ttsClient.js";
import { mulawToPcm16 } from "./gnani/audio.js";
import { nextConversationLanguage, isGoodbye } from "./gnani/language.js";
import { phrase } from "./gnani/phrases.js";
import { findOrCreateCallByCallSid, getHistoryForRag, appendTurn } from "./callService.js";
import { askRagService } from "./ragClient.js";

export const STREAM_PATH_PREFIX = "/voice/stream/";
const TOKEN_MAX_AGE_SECONDS = 600;

// ---------------------------------------------------------------------------
// Authenticating the WebSocket.
// Twilio does not allow query strings on a <Stream> url, so the URL we hand
// Twilio (inside the already-signature-checked /voice/incoming response)
// carries a signed token in its PATH: callSid + timestamp + HMAC. Nobody
// without TWILIO_AUTH_TOKEN can forge a URL that opens a call session.
// ---------------------------------------------------------------------------

function sign(callSid, timestamp) {
  return crypto
    .createHmac("sha256", config.twilioAuthToken)
    .update(`voice-stream:${callSid}:${timestamp}`)
    .digest("hex")
    .slice(0, 32);
}

export function makeStreamToken(callSid) {
  const timestamp = Math.floor(Date.now() / 1000);
  return `${callSid}.${timestamp}.${sign(callSid, timestamp)}`;
}

/** Returns the callSid if the token is genuine and fresh, otherwise null. */
export function verifyStreamToken(token) {
  const [callSid, timestamp, signature, ...extra] = String(token || "").split(".");
  if (!callSid || !timestamp || !signature || extra.length) return null;
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || age < -60 || age > TOKEN_MAX_AGE_SECONDS) return null;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(callSid, timestamp));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return callSid;
}

// ---------------------------------------------------------------------------

const REAL_DEPS = {
  findOrCreateCall: findOrCreateCallByCallSid,
  getHistory: getHistoryForRag,
  appendTurn,
  askRag: askRagService,
};

class CallSession {
  constructor(ws, callSid, { deps = {}, options = {} } = {}) {
    this.ws = ws;
    this.callSid = callSid;
    this.deps = { ...REAL_DEPS, ...deps };
    this.options = {
      silenceTimeoutMs: config.silenceTimeoutMs,
      endCallDelayMs: 1500,
      stt: {},
      tts: {},
      ...options,
    };
    this.tag = callSid.slice(-6);

    this.state = "starting"; // starting -> speaking -> listening -> thinking -> speaking ...
    this.streamSid = null;
    this.callId = null;
    this.language = null; // the conversation's language so far, e.g. "hi-IN"
    this.stt = null;
    this.tts = null;
    this.markSeq = 0;
    this.pendingMark = null;
    this.endAfterReply = false;
    this.reprompts = 0;
    this.silenceTimer = null;
    this.persist = Promise.resolve(); // the previous turn's database write
    this.closed = false;
  }

  log(...args) {
    console.log(`[voice ${this.tag}]`, ...args);
  }

  attach() {
    this.ws.on("message", (raw) => this.onTwilioMessage(raw));
    this.ws.on("close", () => {
      this.log("Twilio closed the stream");
      this.cleanup();
    });
    this.ws.on("error", (err) => this.log("Twilio socket error:", err.message));
  }

  // ----- Twilio -> us -----

  onTwilioMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case "start":
        this.onStart(msg).catch((err) => {
          this.log("could not start the call:", err.message);
          this.end("start-failed");
        });
        break;
      case "media":
        this.onMedia(msg);
        break;
      case "mark":
        this.onMark(msg);
        break;
      case "stop":
        this.log("call ended (stop event)");
        this.cleanup();
        break;
      default:
        break; // "connected", "dtmf"
    }
  }

  async onStart(msg) {
    const start = msg.start || {};
    if (start.callSid !== this.callSid) {
      throw new Error(`stream token was issued for ${this.callSid} but Twilio started ${start.callSid}`);
    }
    this.streamSid = msg.streamSid || start.streamSid;
    const callerNumber = start.customParameters?.callerNumber || null;
    this.log(`stream started (${this.streamSid}), caller ${callerNumber || "unknown"}`);

    // Create the speech clients first so caller audio arriving meanwhile is buffered, not lost.
    this.stt = new GnaniStt(this.options.stt);
    this.tts = new GnaniTts(this.options.tts);
    this.stt.on("transcript", (t) => this.onTranscript(t));
    this.stt.on("speech_start", () => {
      if (this.state === "listening") this.clearSilenceTimer();
    });
    this.stt.on("error", (err) => this.log("STT error:", err.message));

    const [call] = await Promise.all([
      this.deps.findOrCreateCall(this.callSid, callerNumber),
      this.stt.connect(),
      this.tts.connect(),
    ]);
    this.callId = call._id.toString();
    this.log("Gnani connected, greeting the caller");
    await this.say(phrase("greeting"));
  }

  onMedia(msg) {
    if (!this.stt) return;
    if (msg.media?.track && msg.media.track !== "inbound") return;
    const mulaw = Buffer.from(msg.media?.payload || "", "base64");
    if (mulaw.length) this.stt.write(mulawToPcm16(mulaw));
  }

  onMark(msg) {
    if (!this.pendingMark || msg.mark?.name !== this.pendingMark) return;
    this.pendingMark = null; // Twilio has now finished PLAYING the reply to the caller
    if (this.endAfterReply) {
      setTimeout(() => this.end("goodbye"), this.options.endCallDelayMs);
      return;
    }
    this.state = "listening";
    this.startSilenceTimer();
  }

  // ----- us -> Twilio -----

  sendToTwilio(message) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** Speak `text` to the caller. Resolves when the audio has been handed to Twilio. */
  async say(text) {
    if (this.closed) return;
    this.state = "speaking";
    this.clearSilenceTimer();
    const mark = `reply-${++this.markSeq}`;
    this.pendingMark = mark;
    try {
      const stats = await this.tts.speak(text, {
        onAudio: (audio) =>
          this.sendToTwilio({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: audio.toString("base64") },
          }),
      });
      this.log(`spoke ${stats.audioSeconds.toFixed(1)}s of audio (first audio after ${stats.firstAudioMs} ms)`);
    } catch (err) {
      this.log("TTS failed:", err.message);
    }
    // Twilio echoes this mark back once everything before it has actually played.
    this.sendToTwilio({ event: "mark", streamSid: this.streamSid, mark: { name: mark } });
  }

  // ----- hearing the caller -----

  onTranscript(t) {
    if (this.closed) return;
    if (this.state !== "listening") {
      this.log(`ignored "${t.text}" (heard while ${this.state})`);
      return;
    }
    this.clearSilenceTimer();
    this.state = "thinking";
    this.handleTurn(t).catch((err) => {
      this.log("turn failed:", err.message);
      this.state = "listening";
      this.startSilenceTimer();
    });
  }

  async handleTurn(t) {
    const heardAt = Date.now();
    this.reprompts = 0;
    this.language = nextConversationLanguage(this.language, t.text, t.language);
    this.log(`heard "${t.text}" (Gnani tag ${t.language}, STT ${t.latencyMs} ms) -> conversation language ${this.language}`);

    await this.persist; // the previous turn must be saved before its history is read
    const history = (await this.deps.getHistory(this.callId)) || [];

    let answer;
    let classification = "normal";
    try {
      ({ answer, classification } = await this.deps.askRag(t.text, history, this.language));
    } catch (err) {
      this.log("RAG service failed:", err.message);
      await this.say(phrase("trouble", this.language));
      return;
    }
    this.log(`answer in ${Date.now() - heardAt} ms: "${answer}" [${classification}]`);

    if (isGoodbye(t.text)) this.endAfterReply = true;
    this.persist = Promise.resolve(this.deps.appendTurn(this.callId, t.text, answer, classification)).catch((err) =>
      this.log("could not save the turn:", err.message)
    );
    await this.say(answer);
  }

  // ----- silence handling -----

  startSilenceTimer() {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => this.onSilence(), this.options.silenceTimeoutMs);
  }

  clearSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  async onSilence() {
    if (this.closed || this.state !== "listening") return;
    if (this.reprompts < 1) {
      this.reprompts += 1;
      this.log("caller silent, asking if they are still there");
      await this.say(phrase("stillThere", this.language));
    } else {
      this.log("caller still silent, ending the call");
      this.endAfterReply = true;
      await this.say(phrase("goodbyeSilence", this.language));
    }
  }

  // ----- ending -----

  /** Hang up: closing the stream makes Twilio end the call (nothing follows <Connect> in the TwiML). */
  end(reason) {
    if (this.closed) return;
    this.log(`ending the call (${reason})`);
    this.cleanup();
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  cleanup() {
    this.closed = true;
    this.clearSilenceTimer();
    if (this.stt) this.stt.close();
    if (this.tts) this.tts.close();
  }
}

/**
 * Lets the HTTP server accept Twilio's media-stream WebSocket at
 * /voice/stream/<signed token>. Call once, with the object returned by app.listen().
 * `deps` and `sessionOptions` exist for tests only.
 */
export function attachVoiceStream(httpServer, { deps = {}, sessionOptions = {} } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (!pathname.startsWith(STREAM_PATH_PREFIX)) {
      socket.destroy();
      return;
    }
    const callSid = verifyStreamToken(decodeURIComponent(pathname.slice(STREAM_PATH_PREFIX.length)));
    if (!callSid) {
      console.error("[voice] REJECTED a media-stream connection: invalid or expired token");
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      new CallSession(ws, callSid, { deps, options: sessionOptions }).attach();
    });
  });

  console.log(`Voice stream ready: Twilio media streams connect to ${STREAM_PATH_PREFIX}<token> (VOICE_MODE=${config.voiceMode})`);
}