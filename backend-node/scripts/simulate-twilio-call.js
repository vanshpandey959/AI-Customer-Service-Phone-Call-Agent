// Plays the part of Twilio so you can test the whole voice loop WITHOUT a phone call or ngrok:
// it connects to your running server's media-stream WebSocket exactly like Twilio does, plays
// your recording(s) as the caller, and saves what the agent says back.
//
//   node scripts/simulate-twilio-call.js ..\tests\test.wav
//   node scripts/simulate-twilio-call.js hindi-question.wav punjabi-question.wav   (one caller turn per file)
//   node scripts/simulate-twilio-call.js q.wav --url ws://localhost:5000 --fast
//
// Start the Python service and the Node server first (needs the Gnani, Groq and Mongo settings in .env).
// It creates one test call record (CallSid CAsim...) in your database. Safe to delete.
// --fast: do not wait for the agent's audio to "play" before the caller answers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { config } from "../src/config.js";
import { makeStreamToken } from "../src/voiceStream.js";
import { mulawToPcm16, pcm16ToMulaw, pcm16ToWav, wavToPcm8k } from "../src/gnani/audio.js";

const args = process.argv.slice(2);
const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const fast = args.includes("--fast");
const baseUrl = flagValue("--url") || `ws://localhost:${config.port}`;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");
if (!files.length) {
  console.error("Usage: node scripts/simulate-twilio-call.js <caller.wav> [more.wav ...] [--url ws://host:port] [--fast]");
  process.exit(1);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(outDir, { recursive: true });

const FRAME_BYTES = 160; // 20 ms of 8 kHz mu-law, like a Twilio media message
const SILENCE = Buffer.alloc(FRAME_BYTES, 0xff);
const callSid = `CAsim${Date.now()}`;
const streamSid = `MZsim${Date.now()}`;
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

// ----- the caller's microphone: silence unless a recording is queued -----
const micQueue = [];
let speechEndedAt = null;
function queueSpeech(file) {
  const pcm = wavToPcm8k(fs.readFileSync(file));
  const mulaw = pcm16ToMulaw(pcm);
  for (let off = 0; off < mulaw.length; off += FRAME_BYTES) {
    const buf = Buffer.alloc(FRAME_BYTES, 0xff);
    mulaw.copy(buf, 0, off, Math.min(off + FRAME_BYTES, mulaw.length));
    micQueue.push({ buf, last: off + FRAME_BYTES >= mulaw.length });
  }
}

// ----- the agent's replies as they arrive -----
let reply = null; // { chunks: [], firstAt, triggeredAt }
let replyCount = 0;
let turnIndex = 0;
const summary = [];
let finished = false;

const ws = new WebSocket(`${baseUrl}/voice/stream/${makeStreamToken(callSid)}`);
let micTimer = null;

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(micTimer);
  console.log(`\n${message}`);
  for (const line of summary) console.log(line);
  try {
    ws.send(JSON.stringify({ event: "stop", streamSid, stop: { callSid } }));
    ws.close();
  } catch {
    /* already closed */
  }
  setTimeout(() => process.exit(code), 300);
}

function startMic() {
  const begin = Date.now();
  let n = 0;
  const tick = () => {
    if (finished || ws.readyState !== WebSocket.OPEN) return;
    const next = micQueue.shift();
    const frame = next ? next.buf : SILENCE;
    if (next?.last) speechEndedAt = Date.now();
    ws.send(JSON.stringify({ event: "media", streamSid, media: { track: "inbound", chunk: String(++n), payload: frame.toString("base64") } }));
    micTimer = setTimeout(tick, Math.max(0, begin + (n + 1) * 20 - Date.now()));
  };
  tick();
}

ws.on("open", () => {
  console.log(stamp(), `connected to ${baseUrl}, simulating call ${callSid}`);
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(
    JSON.stringify({
      event: "start",
      streamSid,
      start: {
        accountSid: "ACsim",
        streamSid,
        callSid,
        tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { callerNumber: "+910000000000" },
      },
    })
  );
  startMic();
});

ws.on("unexpected-response", (req, res) => {
  console.error(`The server rejected the connection: HTTP ${res.statusCode}. Is it running, and does this PC's TWILIO_AUTH_TOKEN match the server's?`);
  process.exit(1);
});
ws.on("error", (err) => {
  console.error("Connection error:", err.message, "- is the Node server running?");
  process.exit(1);
});
ws.on("close", () => finish(summary.length >= files.length ? 0 : 1, "The server closed the stream."));

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (msg.event === "media") {
    if (!reply) reply = { chunks: [], firstAt: Date.now() };
    reply.chunks.push(Buffer.from(msg.media.payload, "base64"));
    return;
  }

  if (msg.event === "mark") {
    // The agent has handed over a whole reply. Real Twilio echoes the mark after it has PLAYED it.
    replyCount += 1;
    const audio = Buffer.concat(reply?.chunks || []);
    const seconds = audio.length / 8000;
    const first = reply?.firstAt ?? Date.now();
    const file = path.join(outDir, `sim-reply-${replyCount}.wav`);
    fs.writeFileSync(file, pcm16ToWav(mulawToPcm16(audio), 8000));

    let line = `reply ${replyCount}: ${seconds.toFixed(1)} s of audio -> ${path.relative(process.cwd(), file)}`;
    if (replyCount > 1 && speechEndedAt) {
      line += `, first audio ${first - speechEndedAt} ms after the caller stopped talking`;
    }
    console.log(stamp(), line);
    summary.push(line);
    reply = null;

    const playMs = fast ? 0 : Math.max(0, first + seconds * 1000 - Date.now());
    setTimeout(() => {
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: msg.mark.name } }));
      if (turnIndex < files.length) {
        console.log(stamp(), `caller speaks: ${path.basename(files[turnIndex])}`);
        queueSpeech(files[turnIndex++]);
      } else {
        // give the server a moment to save the last turn, then hang up
        setTimeout(() => finish(0, "Call finished."), 1500);
      }
    }, playMs);
  }
});

setTimeout(() => finish(1, "Timed out after 90 s: the agent stopped answering. Check the server console."), 90000);