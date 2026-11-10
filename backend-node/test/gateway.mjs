import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { WebSocketServer, WebSocket } from "ws";

process.env.MONGODB_URI = "mongodb://localhost/unused";
process.env.TWILIO_AUTH_TOKEN = "testtoken";
process.env.GNANI_API_KEY = "k";
process.env.GNANI_VOICE = "v";

const { attachVoiceStream, makeStreamToken, verifyStreamToken } = await import("../src/voiceStream.js");
const { pcm16ToMulaw, pcm16ToWav, sleep } = await import("../src/gnani/audio.js");

// ---------- tokens ----------
{
  const token = makeStreamToken("CA123");
  assert.equal(verifyStreamToken(token), "CA123");
  assert.equal(verifyStreamToken(token + "x"), null);
  assert.equal(verifyStreamToken(token.replace("CA123", "CA124")), null);
  assert.equal(verifyStreamToken("garbage"), null);
  assert.equal(verifyStreamToken(""), null);
  const old = `CA123.${Math.floor(Date.now() / 1000) - 5000}.deadbeef`;
  assert.equal(verifyStreamToken(old), null);
  console.log("tokens ok");
}

// ---------- fake Gnani ----------
const gnani = { ttsTexts: [], transcripts: [] };       // transcripts: queue of [text, tag]
const tts = new WebSocketServer({ port: 0 });
tts.on("connection", (ws) => ws.on("message", async (raw) => {
  gnani.ttsTexts.push(JSON.parse(raw.toString()).text);
  const pcm = Buffer.alloc(4800 * 2);   // 0.6 s of tone
  for (let i = 0; i < 4800; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / 6)), i * 2);
  const mu = pcm16ToMulaw(pcm);
  ws.send(JSON.stringify({ type: "start" }));
  for (let off = 0; off < mu.length; off += 1600) {
    await sleep(5);
    ws.send(JSON.stringify({ type: "audio", data: { audio: mu.subarray(off, off + 1600).toString("base64") } }));
  }
  ws.send(JSON.stringify({ type: "complete", data: { audio: "", is_final: true } }));
  ws.send(JSON.stringify({ type: "complete", message: "Streaming completed" }));
}));
const stt = new WebSocketServer({ port: 0 });
stt.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "connected", config: {} }));
  let inSpeech = false, quiet = 0;
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return;
    assert.equal(data.length, 1024, "STT frames must be exactly 1024 bytes");
    let peak = 0; for (let i = 0; i < 1024; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
    if (peak > 500) { if (!inSpeech) ws.send(JSON.stringify({ type: "speech_start", utterance_id: "u" })); inSpeech = true; quiet = 0; }
    else if (inSpeech && ++quiet >= 8) {
      inSpeech = false;
      const [text, tag] = gnani.transcripts.shift() || ["fallback text", "en-IN"];
      ws.send(JSON.stringify({ type: "transcript", text, detected_language_code: tag, latency: 120, audio_duration_ms: 1000, is_final: true }));
    }
  });
});
await Promise.all([new Promise((r) => tts.on("listening", r)), new Promise((r) => stt.on("listening", r))]);

// ---------- the server under test (real gateway, fake database / RAG) ----------
const rec = { askRag: [], appendTurn: [], findOrCreate: [] };
let ragMode = "ok";
let dbMode = "ok";
const deps = {
  findOrCreateCall: async (sid, num) => {
    rec.findOrCreate.push([sid, num]);
    if (dbMode === "down") throw new Error("database is down");
    return { _id: { toString: () => "call-1" } };
  },
  getHistory: async () => { if (dbMode === "down") throw new Error("database is down"); return []; },
  appendTurn: async (...a) => { rec.appendTurn.push(a); },
  askRag: async (msg, hist, lang) => {
    rec.askRag.push([msg, lang]);
    if (ragMode === "fail") throw new Error("python down");
    return { answer: "दाल मखनी 280 रुपये की है।", classification: "normal" };
  },
};
const server = http.createServer((req, res) => res.end("ok"));
attachVoiceStream(server, {
  deps,
  sessionOptions: {
    silenceTimeoutMs: 400, endCallDelayMs: 50,
    stt: { sttUrl: `ws://127.0.0.1:${stt.address().port}` },
    tts: { ttsUrl: `ws://127.0.0.1:${tts.address().port}` },
  },
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `ws://127.0.0.1:${port}`;

// ---------- a minimal fake Twilio ----------
function twilioClient(callSid) {
  const ws = new WebSocket(`${base}/voice/stream/${makeStreamToken(callSid)}`);
  const t = { ws, media: 0, marks: [], closed: false, streamSid: "MZ1" };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.event === "media") t.media++;
    if (m.event === "mark") t.marks.push(m.mark.name);
  });
  ws.on("close", () => (t.closed = true));
  t.start = () => ws.send(JSON.stringify({ event: "start", streamSid: t.streamSid, start: { callSid, streamSid: t.streamSid, customParameters: { callerNumber: "+911234" } } }));
  t.echo = (name) => ws.send(JSON.stringify({ event: "mark", streamSid: t.streamSid, mark: { name } }));
  // caller audio, 20 ms frames: `speechMs` of tone, then `silenceMs` of silence
  t.talk = async (speechMs, silenceMs = 900) => {
    const frame = (tone) => {
      const pcm = Buffer.alloc(160 * 2);
      if (tone) for (let i = 0; i < 160; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / 3)), i * 2);
      return pcm16ToMulaw(pcm).toString("base64");
    };
    for (let ms = 0; ms < speechMs + silenceMs; ms += 20) {
      ws.send(JSON.stringify({ event: "media", streamSid: t.streamSid, media: { track: "inbound", payload: frame(ms < speechMs) } }));
      await sleep(20);
    }
  };
  t.waitFor = async (cond, what, ms = 4000) => { const s = Date.now(); while (!cond()) { if (Date.now() - s > ms) throw new Error("timed out waiting for " + what); await sleep(10); } };
  return new Promise((resolve, reject) => { ws.on("open", () => resolve(t)); ws.on("error", reject); });
}
const reset = () => { rec.askRag.length = rec.appendTurn.length = rec.findOrCreate.length = 0; gnani.ttsTexts.length = 0; gnani.transcripts.length = 0; ragMode = "ok"; dbMode = "ok"; };

// 1. bad / missing token is rejected before any WebSocket opens
{
  for (const url of [`${base}/voice/stream/bogus`, `${base}/voice/stream/`, `${base}/other`]) {
    const ws = new WebSocket(url);
    const outcome = await new Promise((resolve) => { ws.on("open", () => resolve("open")); ws.on("unexpected-response", (q, r) => resolve(r.statusCode)); ws.on("error", () => resolve("error")); });
    assert.notEqual(outcome, "open", url);
  }
  console.log("rejects bad tokens ok");
}

// 2. greeting, then a Hindi question, answered in order; history/language handed to RAG; turn saved
{
  reset(); gnani.transcripts.push(["दाल मखनी कितने रुपये की है?", "hi-IN"]);
  const t = await twilioClient("CAtest1"); t.start();
  await t.waitFor(() => t.marks.length === 1, "greeting mark");
  assert.ok(t.media >= 2); assert.match(gnani.ttsTexts[0], /Chandigarh Cafe and Restaurant/); assert.match(gnani.ttsTexts[0], /हिंदी/);
  assert.deepEqual(rec.findOrCreate[0], ["CAtest1", "+911234"]);
  t.echo("reply-1");                                    // Twilio finished playing the greeting
  await sleep(50); await t.talk(900);
  await t.waitFor(() => t.marks.length === 2, "answer mark");
  assert.deepEqual(rec.askRag, [["दाल मखनी कितने रुपये की है?", "hi-IN"]]);
  assert.equal(gnani.ttsTexts[1], "दाल मखनी 280 रुपये की है।");
  await sleep(30); assert.equal(rec.appendTurn.length, 1); assert.deepEqual(rec.appendTurn[0], ["call-1", "दाल मखनी कितने रुपये की है?", "दाल मखनी 280 रुपये की है।", "normal", "hi-IN"]);
  t.ws.close(); await sleep(50);
  console.log("greeting + one turn ok");
}

// 3. speech while the agent is still talking is ignored; after the mark echo it is heard
{
  reset(); gnani.transcripts.push(["interrupting words here", "en-IN"], ["दाल मखनी कितने रुपये की है?", "hi-IN"]);
  const t = await twilioClient("CAtest2"); t.start();
  await t.waitFor(() => t.marks.length === 1, "greeting mark");
  await t.talk(800);                                   // caller talks BEFORE the greeting has "played"
  await sleep(200); assert.equal(rec.askRag.length, 0, "must ignore speech while the agent is speaking");
  t.echo("reply-1"); await sleep(30);
  await t.talk(800);
  await t.waitFor(() => t.marks.length === 2, "answer mark");
  assert.equal(rec.askRag.length, 1); assert.equal(rec.askRag[0][0], "दाल मखनी कितने रुपये की है?");
  t.ws.close(); await sleep(50);
  console.log("ignores interruptions ok");
}

// 4. silence: "are you still there?" then goodbye, then the server hangs up
{
  reset();
  const t = await twilioClient("CAtest3"); t.start();
  await t.waitFor(() => t.marks.length === 1, "greeting mark"); t.echo("reply-1");
  await t.waitFor(() => t.marks.length === 2, "still-there prompt");
  assert.equal(gnani.ttsTexts[1], "Are you still there?"); t.echo("reply-2");
  await t.waitFor(() => t.marks.length === 3, "goodbye");
  assert.match(gnani.ttsTexts[2], /Goodbye/); t.echo("reply-3");
  await t.waitFor(() => t.closed, "server hang-up");
  console.log("silence handling ok");
}

// 5. caller says bye -> answered, then the call ends; language follows the script
{
  reset(); gnani.transcripts.push(["ਧੰਨਵਾਦ, bye", "pa-IN"]);
  const t = await twilioClient("CAtest4"); t.start();
  await t.waitFor(() => t.marks.length === 1, "greeting mark"); t.echo("reply-1"); await sleep(30);
  await t.talk(800);
  await t.waitFor(() => t.marks.length === 2, "answer"); assert.equal(rec.askRag[0][1], "pa-IN"); t.echo("reply-2");
  await t.waitFor(() => t.closed, "hang up after goodbye");
  console.log("goodbye ends the call ok");
}

// 6. RAG service down -> a spoken apology in the caller's language, call keeps going
{
  reset(); ragMode = "fail"; gnani.transcripts.push(["ਦਾਲ ਮੱਖਣੀ ਦਾ ਰੇਟ ਕੀ ਹੈ?", "pa-IN"]);
  const t = await twilioClient("CAtest5"); t.start();
  await t.waitFor(() => t.marks.length === 1, "greeting mark"); t.echo("reply-1"); await sleep(30);
  await t.talk(800);
  await t.waitFor(() => t.marks.length === 2, "apology");
  assert.match(gnani.ttsTexts[1], /ਦਿੱਕਤ/); assert.equal(rec.appendTurn.length, 0);
  t.echo("reply-2"); await sleep(30);
  ragMode = "ok"; gnani.transcripts.push(["ਦਾਲ ਮੱਖਣੀ ਦਾ ਰੇਟ ਕੀ ਹੈ?", "pa-IN"]);
  await t.talk(800); await t.waitFor(() => t.marks.length === 3, "second try works");
  t.ws.close(); await sleep(50);
  console.log("RAG failure handled ok");
}

// 6b. database down: the call must still work (greeting + answers), it just is not saved
{
  reset(); dbMode = "down"; gnani.transcripts.push(["दाल मखनी कितने रुपये की है?", "hi-IN"]);
  const t = await twilioClient("CAtest6"); t.start();
  await t.waitFor(() => t.marks.length === 1, "greeting even though the database is down");
  t.echo("reply-1"); await sleep(30);
  await t.talk(800);
  await t.waitFor(() => t.marks.length === 2, "answer even though the database is down");
  assert.equal(rec.askRag.length, 1); assert.equal(rec.appendTurn.length, 0); assert.ok(!t.closed);
  t.ws.close(); await sleep(50);
  console.log("database outage does not hang up on the caller ok");
}

// 6c. Twilio never echoes the mark: the watchdog must still move the call on
{
  reset();
  const server2 = http.createServer();
  attachVoiceStream(server2, {
    deps,
    sessionOptions: { silenceTimeoutMs: 300, endCallDelayMs: 50, markGraceMs: 200,
      stt: { sttUrl: `ws://127.0.0.1:${stt.address().port}` }, tts: { ttsUrl: `ws://127.0.0.1:${tts.address().port}` } },
  });
  await new Promise((r) => server2.listen(0, r));
  const ws = new WebSocket(`ws://127.0.0.1:${server2.address().port}/voice/stream/${makeStreamToken("CAtest7")}`);
  const marks = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.event === "mark") marks.push(m.mark.name); });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ event: "start", streamSid: "MZ7", start: { callSid: "CAtest7", streamSid: "MZ7", customParameters: {} } }));
  const began = Date.now();
  while (marks.length < 2 && Date.now() - began < 4000) await sleep(20);   // greeting, then "are you still there?" without any echo from us
  assert.equal(marks.length, 2, "the call stalled because the mark was never echoed");
  assert.equal(gnani.ttsTexts[1], "Are you still there?");
  ws.close(); server2.close();
  console.log("missing mark echo does not stall the call ok");
}

// 7. the simulator script end to end: two caller turns (Hindi, then English)
{
  reset(); gnani.transcripts.push(["दाल मखनी कितने रुपये की है?", "hi-IN"], ["What time do you close on Friday?", "en-IN"]);
  const pcm = Buffer.alloc(8000 * 2);                 // 1 s "speech"
  for (let i = 0; i < 8000; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / 5)), i * 2);
  const callerWav = path.join(os.tmpdir(), `caller-${process.pid}.wav`);
  fs.writeFileSync(callerWav, pcm16ToWav(pcm, 8000));
  const child = spawn("node", ["scripts/simulate-twilio-call.js", callerWav, callerWav, "--url", base, "--fast"],
    { env: { ...process.env, PORT: String(port) }, cwd: ROOT });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  console.log(out.split("\n").map((l) => "   | " + l).join("\n"));
  assert.equal(code, 0, "simulator exit code");
  assert.deepEqual(rec.askRag.map((r) => r[1]), ["hi-IN", "en-IN"]);
  assert.ok(fs.existsSync(path.join(ROOT, "scripts/out/sim-reply-3.wav")));
  assert.match(out, /first audio \d+ ms after the caller stopped talking/);
  console.log("simulator ok");
}

console.log("\nALL GATEWAY TESTS PASSED");
process.exit(0);
