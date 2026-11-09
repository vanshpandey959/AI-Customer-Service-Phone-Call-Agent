import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { gnaniConfig } from "./gnaniConfig.js";
import { FrameChunker, sleep } from "./audio.js";

const FRAME_BYTES = 1024; // Gnani STT takes exactly 1024-byte frames of 16-bit PCM
const FRAME_MS = (FRAME_BYTES / 2 / 8000) * 1000; // 64 ms at 8 kHz

/**
 * Gnani speech-to-text over WebSocket, one connection per phone call.
 *
 *   const stt = new GnaniStt();
 *   stt.on("transcript", ({ text, language }) => ...);
 *   await stt.connect();
 *   stt.write(pcm16Buffer);   // any chunk size, 8 kHz mono 16-bit little-endian
 *
 * Events:
 *   "ready"         the server accepted the connection
 *   "speech_start"  { utteranceId }   the caller started talking
 *   "transcript"    { text, language, latencyMs, audioMs, utteranceId, isFinal, raw }
 *                   one per finished utterance; language is e.g. "hi-IN" (auto-detected)
 *   "error"         Error (only emitted if someone is listening)
 *   "close"
 *
 * In production, Twilio delivers audio in real time, so write() sends straight away.
 * Offline tests must pace the audio themselves: use streamRealtime().
 */
export class GnaniStt extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cfg = { ...gnaniConfig, ...options };
    if (!this.cfg.apiKey) throw new Error("GNANI_API_KEY must be set (see the Gnani section of .env)");
    this.ws = null;
    this.ready = false;
    this.chunker = new FrameChunker(FRAME_BYTES);
    this.backlog = []; // frames written before the server said "connected"
  }

  connect({ timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const c = this.cfg;
      const ws = new WebSocket(c.sttUrl, {
        headers: {
          "x-api-key-id": c.apiKey,
          // the docs spell these two both ways, so both are sent
          model: c.sttModel,
          "x-model": c.sttModel,
          format: c.sttFormat,
          "x-format": c.sttFormat,
          language_code: c.sttLanguage,
          "x-sample-rate": String(c.sampleRate),
          "x-vad-threshold": String(c.vadThreshold),
          "x-min-speech-ms": String(c.minSpeechMs),
          "x-min-silence-ms": String(c.minSilenceMs),
        },
      });
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error("Gnani STT did not answer within " + timeoutMs + " ms"));
      }, timeoutMs);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "connected") {
          this.ready = true;
          for (const frame of this.backlog) ws.send(frame);
          this.backlog = [];
          this.emit("ready", msg.config || null);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (msg.type === "speech_start") {
          this.emit("speech_start", { utteranceId: msg.utterance_id ?? null });
        } else if (msg.type === "transcript") {
          const text = (msg.text || "").trim();
          if (!text) return;
          this.emit("transcript", {
            text,
            language: msg.detected_language_code || null,
            latencyMs: msg.latency ?? null,
            audioMs: msg.audio_duration_ms ?? null,
            utteranceId: msg.utterance_id ?? null,
            isFinal: msg.is_final !== false,
            raw: msg,
          });
        } else if (msg.type === "error") {
          this._error(new Error(`Gnani STT error: ${msg.message || JSON.stringify(msg)}`));
        }
      });
      ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        } else {
          this._error(err);
        }
      });
      ws.on("close", () => {
        this.ready = false;
        this.emit("close");
      });
    });
  }

  /** Send audio (16-bit little-endian PCM, 8 kHz mono, any chunk size). */
  write(pcm) {
    for (const frame of this.chunker.push(pcm)) this._sendFrame(frame);
  }

  /** Send whatever is left, padded with silence to a full frame. */
  flush() {
    const last = this.chunker.flush();
    if (last) this._sendFrame(last);
  }

  /** Offline tests only: send `pcm` at real-time speed (one 64 ms frame per 64 ms). */
  async streamRealtime(pcm) {
    const start = Date.now();
    let sent = 0;
    for (const frame of this.chunker.push(pcm)) {
      this._sendFrame(frame);
      sent += 1;
      const wait = start + sent * FRAME_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }

  close() {
    this.backlog = [];
    if (this.ws) this.ws.close();
  }

  _sendFrame(frame) {
    if (!this.ready) {
      this.backlog.push(frame);
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  _error(err) {
    if (this.listenerCount("error") > 0) this.emit("error", err);
    else console.error("[GnaniStt]", err.message);
  }
}