// Gnani speech-to-text check on a recording, no Twilio involved.
//   node scripts/gnani-stt-test.js path/to/recording.wav
//   node scripts/gnani-stt-test.js path/to/recording.pcm
// .wav: any 16-bit PCM wav (mono or stereo, 8 kHz or higher) - converted to 8 kHz mono automatically.
//       (an .m4a/.mp3 must be converted first: ffmpeg -i in.m4a out.wav)
// .pcm: raw 16-bit little-endian, 8000 Hz, mono.
// Needs GNANI_API_KEY in backend-node/.env

import fs from "node:fs";
import path from "node:path";
import { GnaniStt } from "../src/gnani/sttClient.js";
import { wavToPcm8k, silencePcm, sleep } from "../src/gnani/audio.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/gnani-stt-test.js <recording.wav|recording.pcm>");
  process.exit(1);
}
const raw = fs.readFileSync(file);
const pcm = path.extname(file).toLowerCase() === ".wav" ? wavToPcm8k(raw) : raw;
console.log(`${path.basename(file)}: ${(pcm.length / 16000).toFixed(1)} s of audio`);

const stt = new GnaniStt();
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
let transcripts = 0;

stt.on("speech_start", () => console.log(stamp(), "speech started"));
stt.on("transcript", (t) => {
  transcripts += 1;
  console.log(stamp(), `"${t.text}"`);
  console.log(`        language ${t.language}, STT latency ${t.latencyMs} ms, audio ${t.audioMs} ms`);
});
stt.on("error", (err) => console.error(stamp(), "ERROR:", err.message));

await stt.connect();
console.log(stamp(), "connected, streaming at real-time speed...");
await stt.streamRealtime(pcm);
await stt.streamRealtime(silencePcm(2500)); // trailing silence lets the server close the last utterance
stt.flush();
await sleep(3000);
stt.close();
console.log(transcripts ? `\nSTT OK: ${transcripts} transcript(s).` : "\nNo transcript came back.");
process.exit(transcripts ? 0 : 1);