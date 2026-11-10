// Makes short "caller" recordings with Gnani's own voice, so you can test the voice loop
// without recording yourself:
//   node scripts/make-test-questions.js
// Then:
//   node scripts/simulate-twilio-call.js scripts/out/q-hi.wav
//   node scripts/simulate-twilio-call.js scripts/out/q-hi.wav scripts/out/q-pa.wav scripts/out/q-en.wav
// Needs GNANI_API_KEY and GNANI_VOICE in backend-node/.env (uses a few seconds of TTS in total).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GnaniTts } from "../src/gnani/ttsClient.js";
import { mulawToPcm16, pcm16ToWav } from "../src/gnani/audio.js";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(outDir, { recursive: true });

const QUESTIONS = [
  ["hi", "दाल मखनी कितने रुपये की है?"],
  ["pa", "ਸਰ੍ਹੋਂ ਦਾ ਸਾਗ ਮਿਲਦਾ ਹੈ ਕੀ?"],
  ["en", "What time do you close on Friday?"],
  ["mixed", "Sunday को brunch होता है क्या, कितने का है?"],
  ["complaint", "कल मेरा खाना बहुत ठंडा आया था और सर्विस भी बहुत धीमी थी।"],
];

const tts = new GnaniTts();
for (const [tag, text] of QUESTIONS) {
  const { audio, audioSeconds } = await tts.synthesize(text);
  const file = path.join(outDir, `q-${tag}.wav`);
  fs.writeFileSync(file, pcm16ToWav(mulawToPcm16(audio), 8000));
  console.log(`${path.relative(process.cwd(), file)}  (${audioSeconds.toFixed(1)} s)  "${text}"`);
}
tts.close();
process.exit(0);