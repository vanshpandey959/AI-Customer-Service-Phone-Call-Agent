import WebSocket from "ws";
import { gnaniConfig } from "./gnaniConfig.js";

const MULAW_BYTES_PER_SECOND = 8000;

/**
 * Gnani text-to-speech over WebSocket, one connection per phone call.
 *
 *   const tts = new GnaniTts();
 *   await tts.speak("नमस्ते", { onAudio: (mulawBuffer) => sendToTwilio(mulawBuffer) });
 *
 * Audio arrives as raw 8 kHz mu-law chunks (what Twilio plays as-is), starting after
 * roughly 150-400 ms, so the caller hears the reply before it is fully generated.
 *
 * Facts this client is built around (all observed in the live API):
 *  - one request at a time per connection, so speak() calls are queued;
 *  - the server announces the end of each reply TWICE: first {type:"complete",
 *    data:{is_final:true}}, then a plain "Streaming completed" message. Only the first
 *    one ends the reply; the trailing one is swallowed so it cannot cut the next reply short;
 *  - voice and language travel inside each request, so the language can change per reply;
 *  - the connection may be dropped when idle: speak() reconnects automatically.
 */
export class GnaniTts {
  constructor(options = {}) {
    this.cfg = { ...gnaniConfig, ...options };
    if (!this.cfg.apiKey || !this.cfg.voice) {
      throw new Error("GNANI_API_KEY and GNANI_VOICE must be set (see the Gnani section of .env)");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    this.ws = null;
    this.connecting = null;
    this.current = null; // the request waiting for audio
    this.expectTrailing = false; // a trailing "Streaming completed" is still on its way
    this.connectionsOpened = 0; // how many times a connection had to be opened (1 = never dropped)
    this.queue = Promise.resolve();
  }

  /** Open the connection (also called automatically by speak()). */
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.ttsUrl, {
        headers: { "X-API-Key-ID": this.cfg.apiKey, "Content-Type": "application/json" },
      });
      let opened = false;

      ws.on("open", () => {
        opened = true;
        this.connectionsOpened += 1;
        this.ws = ws;
        this.connecting = null;
        this.expectTrailing = false;
        resolve();
      });
      ws.on("message", (raw) => this._onMessage(raw));
      ws.on("error", (err) => {
        if (!opened) {
          this.connecting = null;
          reject(err);
        } else if (this.ws === ws) {
          this._rejectCurrent(err);
        }
      });
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        this._rejectCurrent(new Error("TTS connection closed"), true);
      });
    });
    return this.connecting;
  }

  /**
   * Speak `text`. Resolves when the whole reply has been generated, with
   * { chunks, bytes, firstAudioMs, totalMs, audioSeconds }.
   * Options: onAudio(buffer) for each chunk, language ("auto" by default), speed, voice.
   */
  speak(text, options = {}) {
    const job = () => this._speak(text, options);
    const result = this.queue.then(job, job);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Convenience for tests: speak and return { audio: Buffer (all mu-law), ...stats }. */
  async synthesize(text, options = {}) {
    const parts = [];
    const stats = await this.speak(text, { ...options, onAudio: (buf) => parts.push(buf) });
    return { audio: Buffer.concat(parts), ...stats };
  }

  /** Stop the current reply (e.g. the caller interrupted): drops the connection; the next speak() reconnects. */
  cancel() {
    const cur = this.current;
    if (cur) {
      clearTimeout(cur.timer);
      this.current = null;
      cur.resolve({ cancelled: true, ...this._stats(cur) });
    }
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
  }

  close() {
    this.cancel();
  }

  async _speak(text, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.connect();
        return await this._sendRequest(text, options);
      } catch (err) {
        // A connection that silently died while idle is found out on first use: retry once.
        if (attempt === 0 && err.retryable) continue;
        throw err;
      }
    }
  }

  _sendRequest(text, { language = "auto", speed, voice, onAudio } = {}) {
    return new Promise((resolve, reject) => {
      const cur = {
        resolve,
        reject,
        onAudio,
        t0: Date.now(),
        chunks: 0,
        bytes: 0,
        firstAudioMs: null,
        timer: null,
      };
      cur.timer = setTimeout(() => {
        this._rejectCurrent(new Error("TTS request timed out"));
        if (this.ws) this.ws.terminate();
      }, this.requestTimeoutMs);
      this.current = cur;

      const payload = {
        text,
        voice: voice || this.cfg.voice,
        model: this.cfg.ttsModel,
        language,
        speed: speed ?? this.cfg.ttsSpeed,
        audio_config: { container: "mulaw" },
      };
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) this._rejectCurrent(err, true);
      });
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const cur = this.current;

    if (msg.type === "audio") {
      const b64 = msg.data?.audio;
      if (!cur || !b64) return;
      const buf = Buffer.from(b64, "base64");
      if (!buf.length) return;
      if (cur.firstAudioMs === null) cur.firstAudioMs = Date.now() - cur.t0;
      cur.chunks += 1;
      cur.bytes += buf.length;
      if (cur.onAudio) cur.onAudio(buf);
    } else if (msg.type === "complete") {
      const isFinal = msg.data?.is_final === true;
      if (!cur) {
        this.expectTrailing = false; // stray message, nothing is waiting for it
      } else if (isFinal) {
        this.expectTrailing = true; // the plain "Streaming completed" follows
        this._finish(cur);
      } else if (this.expectTrailing) {
        this.expectTrailing = false; // that trailing message: ignore it
      } else {
        this._finish(cur); // no is_final was seen: treat this as the end
      }
    } else if (msg.type === "error") {
      this._rejectCurrent(new Error(`Gnani TTS error: ${msg.message || JSON.stringify(msg)}`));
    }
    // type "start" and anything else: nothing to do
  }

  _stats(cur) {
    const totalMs = Date.now() - cur.t0;
    return {
      chunks: cur.chunks,
      bytes: cur.bytes,
      firstAudioMs: cur.firstAudioMs,
      totalMs,
      audioSeconds: cur.bytes / MULAW_BYTES_PER_SECOND,
    };
  }

  _finish(cur) {
    clearTimeout(cur.timer);
    if (this.current === cur) this.current = null;
    cur.resolve(this._stats(cur));
  }

  _rejectCurrent(err, retryableIfNoAudio = false) {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.current = null;
    if (retryableIfNoAudio && cur.chunks === 0) err.retryable = true;
    cur.reject(err);
  }
}