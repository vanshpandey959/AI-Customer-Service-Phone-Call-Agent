// Gnani text-to-speech check, no Twilio involved.
//   node scripts/gnani-tts-test.js
//   node scripts/gnani-tts-test.js --gap 30000     # wait 30 s between replies (does the connection survive idle?)
// Needs GNANI_API_KEY and GNANI_VOICE in backend-node/.env
// Writes scripts/out/tts-*.wav: play them, that is what callers will hear.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GnaniTts } from "../src/gnani/ttsClient.js";
import { mulawToPcm16, pcm16ToWav, sleep } from "../src/gnani/audio.js";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(outDir, { recursive: true });

const gapIndex = process.argv.indexOf("--gap");
const gapMs = gapIndex > -1 ? Number(process.argv[gapIndex + 1]) : 0;

const SENTENCES = [
  ["hi", "दाल मखनी दो सौ अस्सी रुपये की है। हम रात ग्यारह बजकर तीस मिनट तक खुले रहते हैं।"],
  ["pa", "ਦਾਲ ਮੱਖਣੀ ਦੋ ਸੌ ਅੱਸੀ ਰੁਪਏ ਦੀ ਹੈ। ਅਸੀਂ ਹਰ ਰੋਜ਼ ਸਵੇਰੇ ਅੱਠ ਵਜੇ ਤੋਂ ਖੁੱਲ੍ਹਦੇ ਹਾਂ।"],
  ["en", "Thanks for calling Chandigarh Cafe and Restaurant. Dal Makhani is 280 rupees, and we are open until 11:30 PM."],
  ["mixed", "आप table book करने के लिए हमें call कर सकते हैं, weekend पर reservation recommended है।"],
];

const tts = new GnaniTts();
let failures = 0;
for (const [i, [tag, text]] of SENTENCES.entries()) {
  if (i > 0 && gapMs) {
    console.log(`(waiting ${gapMs / 1000} s)`);
    await sleep(gapMs);
  }
  try {
    const r = await tts.synthesize(text);
    const file = path.join(outDir, `tts-${tag}.wav`);
    fs.writeFileSync(file, pcm16ToWav(mulawToPcm16(r.audio), 8000));
    console.log(
      `${tag}: first audio ${r.firstAudioMs} ms, ${r.chunks} chunks, ${r.bytes} bytes = ${r.audioSeconds.toFixed(1)} s of audio, ` +
        `generated in ${r.totalMs} ms -> ${path.relative(process.cwd(), file)}`
    );
  } catch (err) {
    failures += 1;
    console.error(`${tag}: FAILED - ${err.message}`);
  }
}
console.log(`connections opened: ${tts.connectionsOpened} (1 means one connection served every reply)`);
tts.close();
console.log(failures ? `\n${failures} reply(ies) failed.` : "\nTTS OK. Play the .wav files in scripts/out.");
process.exit(failures ? 1 : 0);