// Step 1 smoke tests for Gnani STT / TTS. Run from any empty folder:
//   npm init -y && npm i ws
//   node gnani-check.mjs tts-rest
//   node gnani-check.mjs tts-ws
//   node gnani-check.mjs stt-rest <audio file: wav/mp3/m4a/ogg/flac, max 30 s>
//   node gnani-check.mjs stt-ws   <raw 8 kHz 16-bit mono PCM file>
//
// Required env vars: GNANI_API_KEY, GNANI_VOICE (your chosen voice name)
// Optional env vars: GNANI_TTS_MODEL (default timbre-v3.0), STT_FORMAT (default transcribe),
//                    TTS_GAP_MS (pause between requests in tts-ws, default 0)

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import dotenv from "dotenv";
dotenv.config();

const KEY = process.env.GNANI_API_KEY;
const VOICE = process.env.GNANI_VOICE;
const MODEL = process.env.GNANI_TTS_MODEL || "timbre-v3.0";
const FORMAT = process.env.STT_FORMAT || "transcribe";
const GAP = Number(process.env.TTS_GAP_MS || 0);

if (!KEY || !VOICE) {
  console.error("Set GNANI_API_KEY and GNANI_VOICE first.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HI = "दाल मखनी दो सौ अस्सी रुपये की है।";
const PA = "ਦਾਲ ਮਖਨੀ ਦੋ ਸੌ ਅੱਸੀ ਰੁਪਏ ਦੀ ਹੈ।";
const EN = "Thanks for calling Spice Route Kitchen. Dal Makhani is two hundred eighty rupees.";

// ---------- TTS REST: three output formats of one Hindi sentence ----------
async function ttsRest() {
  const variants = [
    ["tts_8k_mulaw.bin", { container: "mulaw" }],
    ["tts_8k_listen.wav", { container: "wav", encoding: "linear_pcm", sample_rate: 8000, num_channels: 1, sample_width: 2 }],
    ["tts_8k.pcm", { container: "raw", encoding: "linear_pcm", sample_rate: 8000, num_channels: 1, sample_width: 2 }],
  ];
  for (const [file, audio_config] of variants) {
    const t0 = Date.now();
    const r = await fetch("https://api.vachana.ai/api/v1/tts/inference", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key-ID": KEY },
      body: JSON.stringify({ text: HI, voice: VOICE, model: MODEL, language: "auto", speed: 1.0, audio_config }),
    });
    if (!r.ok) {
      console.error(file, "FAILED", r.status, await r.text());
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(file, buf);
    console.log(`${file}: ${buf.length} bytes, ${Date.now() - t0} ms`);
  }
  console.log("Play tts_8k_listen.wav. mulaw bytes / 8000 should roughly equal its length in seconds.");
}

// ---------- TTS WebSocket: several requests on ONE connection ----------
function ttsWs() {
  const ws = new WebSocket("wss://api.vachana.ai/api/v1/tts", {
    headers: { "X-API-Key-ID": KEY, "Content-Type": "application/json" },
  });
  const jobs = [HI, PA, EN];
  const labels = ["Hindi", "Punjabi", "English"];
  let i = 0, t0 = 0, first = null, chunks = 0, bytes = 0, inflight = false;

  const send = () => {
    t0 = Date.now(); first = null; chunks = 0; bytes = 0; inflight = true;
    ws.send(JSON.stringify({
      text: jobs[i], voice: VOICE, model: MODEL, language: "auto", speed: 1.0,
      audio_config: { container: "mulaw" },
    }));
  };

  ws.on("open", () => { console.log("connected"); send(); });
  ws.on("message", (m) => {
    const j = JSON.parse(m.toString());
    if (j.type === "audio") {
      if (first === null) first = Date.now() - t0;
      chunks++;
      bytes += Buffer.from(j.data.audio || "", "base64").length;
    } else if (j.type === "complete") {
      if (!inflight) { console.log("   (extra 'complete' ignored)", JSON.stringify(j)); return; }
      inflight = false;
      console.log("   complete msg:", JSON.stringify(j));
      console.log(`#${i} ${labels[i]}: first audio ${first} ms, ${chunks} chunks, ${bytes} bytes (~${(bytes / 8000).toFixed(1)} s), total ${Date.now() - t0} ms`);
      i++;
      if (i < jobs.length) setTimeout(send, GAP); else ws.close();
    } else {
      console.log(j);
      if (j.type === "error") ws.close();
    }
  });
  ws.on("close", (code) => console.log("closed", code));
  ws.on("error", (e) => console.error("ws error:", e.message));
}

// ---------- STT REST ----------
async function sttRest(file) {
  const form = new FormData();
  form.append("audio_file", new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append("model", "prisma-v3.0");
  form.append("language_code", "indic-auto");
  form.append("format", FORMAT);
  const t0 = Date.now();
  const r = await fetch("https://api.vachana.ai/stt/v3", {
    method: "POST",
    headers: { "X-API-Key-ID": KEY },
    body: form,
  });
  console.log("HTTP", r.status, `${Date.now() - t0} ms round trip`);
  console.log(await r.text());
}

// ---------- STT WebSocket: stream raw 8 kHz PCM at real-time pace ----------
async function sttWs(file) {
  const pcm = fs.readFileSync(file);
  const ws = new WebSocket("wss://api.vachana.ai/stt/v3/stream", {
    headers: {
      "x-api-key-id": KEY,
      // the docs show both spellings for these two, so send both
      "model": "prisma-v3.0", "x-model": "prisma-v3.0",
      "format": FORMAT, "x-format": FORMAT,
      "language_code": "indic-auto",
      "x-sample-rate": "8000",
      "x-vad-threshold": "0.7",
      "x-min-speech-ms": "200",
      "x-min-silence-ms": "500",
    },
  });
  const t0 = Date.now();
  const stamp = () => `[+${Date.now() - t0}ms]`;

  ws.on("message", async (m) => {
    const j = JSON.parse(m.toString());
    if (j.type === "connected") {
      console.log(stamp(), "connected:", JSON.stringify(j.config));
      for (let o = 0; o < pcm.length; o += 1024) {
        let f = pcm.subarray(o, o + 1024);
        if (f.length < 1024) f = Buffer.concat([f, Buffer.alloc(1024 - f.length)]);
        ws.send(f);
        await sleep(64); // 512 samples at 8 kHz
      }
      for (let k = 0; k < 40; k++) { ws.send(Buffer.alloc(1024)); await sleep(64); } // silence so VAD closes the segment
      await sleep(3000);
      ws.close();
    } else if (j.type === "transcript") {
      console.log(stamp(), "TRANSCRIPT:", JSON.stringify(j.text), "| lang:", j.detected_language_code, "| latency:", j.latency, "ms");
      console.log("   full message:", JSON.stringify(j));
    } else {
      console.log(stamp(), JSON.stringify(j));
    }
  });
  ws.on("close", (c) => console.log(stamp(), "closed", c));
  ws.on("error", (e) => console.error("ws error:", e.message));
}

const [cmd, arg] = process.argv.slice(2);
const cmds = { "tts-rest": ttsRest, "tts-ws": ttsWs, "stt-rest": sttRest, "stt-ws": sttWs };
if (!cmds[cmd]) {
  console.error("Commands: tts-rest | tts-ws | stt-rest <file> | stt-ws <file.pcm>");
  process.exit(1);
}
if ((cmd === "stt-rest" || cmd === "stt-ws") && !arg) {
  console.error(`${cmd} needs a file path`);
  process.exit(1);
}
await cmds[cmd](arg);
