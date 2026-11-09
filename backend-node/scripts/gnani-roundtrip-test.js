// Full voice loop WITHOUT Twilio: Gnani speaks three sentences (Hindi, Punjabi, English) in
// the phone format Twilio plays, and that audio is fed back to Gnani STT exactly the way
// Twilio would deliver a caller's voice: 8 kHz mu-law, 160-byte frames every 20 ms, on ONE
// connection, with auto language detection.
//   node scripts/gnani-roundtrip-test.js
// Needs GNANI_API_KEY and GNANI_VOICE in backend-node/.env

import { GnaniTts } from "../src/gnani/ttsClient.js";
import { GnaniStt } from "../src/gnani/sttClient.js";
import { mulawToPcm16, sleep } from "../src/gnani/audio.js";

const CASES = [
  { tag: "hi", text: "दाल मखनी दो सौ अस्सी रुपये की है।", expectLang: "hi", expectText: /280|दो सौ अस्सी/ },
  { tag: "pa", text: "ਦਾਲ ਮੱਖਣੀ ਦੋ ਸੌ ਅੱਸੀ ਰੁਪਏ ਦੀ ਹੈ।", expectLang: "pa", expectText: /280|ਦੋ ਸੌ ਅੱਸੀ|ਅਸੀ/ },
  { tag: "en", text: "Thanks for calling Chandigarh Cafe and Restaurant. Dal Makhani is two hundred eighty rupees.", expectLang: "en", expectText: /280|two hundred (and )?eighty/i },
];
const FRAME_BYTES = 160; // 20 ms of 8 kHz mu-law, like a Twilio media message
const MULAW_SILENCE = 0xff;

// 1. Gnani speaks every sentence (one TTS connection, like a call)
const tts = new GnaniTts();
const spoken = [];
for (const c of CASES) {
  const r = await tts.synthesize(c.text);
  spoken.push(r.audio);
  console.log(`TTS ${c.tag}: ${r.audioSeconds.toFixed(1)} s of audio, first audio after ${r.firstAudioMs} ms`);
}
tts.close();

// 2. Build the "caller's side" of the call: speech, 1.8 s pause, speech, ...
const silence = (ms) => Buffer.alloc((ms / 20) * FRAME_BYTES, MULAW_SILENCE);
const timeline = [];
for (const [i, audio] of spoken.entries()) {
  timeline.push({ audio, speechIndex: i }, { audio: silence(1800), speechIndex: null });
}
timeline.push({ audio: silence(1000), speechIndex: null });

// 3. Feed it to Gnani STT as 20 ms mu-law frames, in real time
const stt = new GnaniStt();
const results = [];
const speechEndedAt = [];
stt.on("transcript", (t) => results.push({ ...t, at: Date.now() }));
stt.on("error", (err) => console.error("STT error:", err.message));
await stt.connect();

const start = Date.now();
let frameNo = 0;
for (const part of timeline) {
  for (let off = 0; off < part.audio.length; off += FRAME_BYTES) {
    const frame = part.audio.subarray(off, off + FRAME_BYTES);
    stt.write(mulawToPcm16(frame)); // what the gateway does with each Twilio media message
    frameNo += 1;
    const wait = start + frameNo * 20 - Date.now();
    if (wait > 0) await sleep(wait);
  }
  if (part.speechIndex !== null) speechEndedAt[part.speechIndex] = Date.now();
}
stt.flush();
await sleep(3500);
stt.close();

// 4. Report
console.log("");
let passed = 0;
for (const [i, c] of CASES.entries()) {
  const t = results[i];
  if (!t) {
    console.log(`FAIL ${c.tag}: no transcript`);
    continue;
  }
  const langOk = (t.language || "").toLowerCase().startsWith(c.expectLang);
  const textOk = c.expectText.test(t.text);
  const delay = t.at - speechEndedAt[i];
  console.log(`${langOk && textOk ? "PASS" : "FAIL"} ${c.tag}: "${t.text}"`);
  console.log(`      language ${t.language} (${langOk ? "ok" : "expected " + c.expectLang}), text ${textOk ? "ok" : "unexpected"}, ` +
    `transcript arrived ${delay} ms after the speech ended (server latency ${t.latencyMs} ms)`);
  if (langOk && textOk) passed += 1;
}
if (results.length !== CASES.length) console.log(`\nNote: expected ${CASES.length} transcripts, got ${results.length}.`);
console.log(`\n${passed}/${CASES.length} sentences passed the round trip.`);
process.exit(passed === CASES.length ? 0 : 1);