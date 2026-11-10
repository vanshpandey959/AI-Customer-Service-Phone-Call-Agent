import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { GnaniTts } from "../src/gnani/ttsClient.js";
import { GnaniStt } from "../src/gnani/sttClient.js";
import { mulawToPcm16, pcm16ToMulaw, pcm16ToWav, wavToPcm8k, silencePcm, FrameChunker, sleep } from "../src/gnani/audio.js";

// ---------------- audio ----------------
{
  const u = (b) => mulawToPcm16(Buffer.from([b])).readInt16LE(0);
  assert.equal(u(0xff), 0); assert.equal(u(0x7f), 0);
  assert.equal(u(0x80), 32124); assert.equal(u(0x00), -32124);
  assert.equal(pcm16ToMulaw(Buffer.from([0, 0]))[0], 0xff);

  // every mu-law byte survives decode -> encode (the 2 zero codes may merge)
  let mismatches = 0;
  for (let b = 0; b < 256; b++) {
    const back = pcm16ToMulaw(mulawToPcm16(Buffer.from([b])))[0];
    if (back !== b) { mismatches++; assert.ok(b === 0x7f || b === 0xff, "unexpected mismatch at " + b); }
  }
  // PCM -> mu-law -> PCM stays within quantisation error
  for (let x = -32000; x <= 32000; x += 137) {
    const pcm = Buffer.alloc(2); pcm.writeInt16LE(x, 0);
    const y = mulawToPcm16(pcm16ToMulaw(pcm)).readInt16LE(0);
    assert.ok(Math.abs(y - x) <= Math.max(20, Math.abs(x) / 15), `x=${x} y=${y}`);
  }
  // sine wave round trip keeps its shape
  const pcm = Buffer.alloc(1600);
  for (let i = 0; i < 800; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(i / 8)), i * 2);
  const rt = mulawToPcm16(pcm16ToMulaw(pcm));
  let maxErr = 0;
  for (let i = 0; i < 800; i++) maxErr = Math.max(maxErr, Math.abs(rt.readInt16LE(i * 2) - pcm.readInt16LE(i * 2)));
  assert.ok(maxErr < 900, "sine error " + maxErr);

  // wav
  const wav = pcm16ToWav(pcm, 8000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.deepEqual(wavToPcm8k(wav), pcm);
  // other sample rates / stereo are converted to 8 kHz mono
  for (const [rate, channels] of [[48000, 1], [16000, 1], [44100, 1], [48000, 2]]) {
    const seconds = 2, hz = 440;
    const src = Buffer.alloc(rate * seconds * channels * 2);
    for (let i = 0; i < rate * seconds; i++) {
      const v = Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / rate));
      for (let c = 0; c < channels; c++) src.writeInt16LE(v, (i * channels + c) * 2);
    }
    const header = pcm16ToWav(src, rate);
    header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate * 2 * channels, 28); header.writeUInt16LE(2 * channels, 32);
    const out = wavToPcm8k(header);
    assert.ok(Math.abs(out.length / 2 - 8000 * seconds) <= 1, `length for ${rate}/${channels}: ${out.length / 2}`);
    // the 440 Hz tone must survive: count rising zero crossings (should be about 440 per second)
    let crossings = 0;
    for (let i = 1; i < out.length / 2; i++) if (out.readInt16LE((i - 1) * 2) < 0 && out.readInt16LE(i * 2) >= 0) crossings++;
    assert.ok(Math.abs(crossings / seconds - hz) < 8, `tone ${rate}/${channels}: ${crossings / seconds} Hz`);
    let peak = 0; for (let i = 0; i < out.length / 2; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(i * 2)));
    assert.ok(peak > 8000 && peak < 11000, `level ${rate}/${channels}: ${peak}`);
  }
  assert.throws(() => { const w = pcm16ToWav(pcm, 8000); w.writeUInt16LE(8, 34); wavToPcm8k(w); }, /Unsupported WAV/);
  assert.throws(() => wavToPcm8k(Buffer.from("hello world, not a wav file at all.........")), /Not a WAV/);
  assert.equal(silencePcm(1000).length, 16000);

  // chunker
  const ch = new FrameChunker(1024);
  assert.equal(ch.push(Buffer.alloc(1000)).length, 0);
  const frames = ch.push(Buffer.alloc(1100));
  assert.equal(frames.length, 2); assert.ok(frames.every((f) => f.length === 1024));
  const tail = ch.flush(); assert.equal(tail.length, 1024); assert.equal(ch.flush(), null);
  console.log("audio ok  (mu-law codes that do not survive exactly: " + mismatches + ")");
}

// ---------------- fake Gnani TTS server ----------------
function startTts(behaviour) {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    const state = { connections: 0, requests: [], headers: [], behaviour };
    server.on("connection", (ws, req) => {
      state.connections++;
      state.headers.push(req.headers["x-api-key-id"]);
      ws.on("message", async (raw) => {
        const req = JSON.parse(raw.toString());
        state.requests.push(req);
        const n = state.requests.length;
        const b = state.behaviour(n, req, ws);
        if (b === "silent") return;
        if (b === "close-now") return ws.close();
        if (b === "error") return ws.send(JSON.stringify({ type: "error", message: "bad voice" }));
        ws.send(JSON.stringify({ type: "start", message: "Streaming started", request_id: "r1" }));
        for (let i = 0; i < 3; i++) {
          await sleep(b === "slow" ? 150 : 5);
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify({ type: "audio", data: { chunk_index: i, audio: Buffer.alloc(1600, 0x55 + i).toString("base64"), is_final: false } }));
        }
        ws.send(JSON.stringify({ type: "complete", data: { chunk_index: 3, audio: "", is_final: true } }));
        await sleep(8); // the trailing duplicate arrives AFTER the client has already queued the next request
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "complete", message: "Streaming completed", request_id: "r1" }));
        if (b === "close-after") setTimeout(() => ws.close(), 30);
      });
    });
    server.on("listening", () => resolve({ server, state, url: `ws://127.0.0.1:${server.address().port}` }));
  });
}
const mk = (url, extra = {}) => new GnaniTts({ apiKey: "KEY", voice: "V", ttsUrl: url, ...extra });

{ // 1. single reply + headers + payload
  const { server, state, url } = await startTts(() => "ok");
  const tts = mk(url); const got = [];
  const r = await tts.speak("नमस्ते", { onAudio: (b) => got.push(b) });
  assert.equal(r.chunks, 3); assert.equal(r.bytes, 4800); assert.equal(got.length, 3);
  assert.ok(r.firstAudioMs !== null && r.audioSeconds === 0.6);
  assert.equal(state.headers[0], "KEY");
  assert.deepEqual(state.requests[0], { text: "नमस्ते", voice: "V", model: "timbre-v3.0", language: "auto", speed: 1, audio_config: { container: "mulaw" } });
  tts.close(); server.close(); console.log("tts single ok");
}
{ // 2. queued replies: the trailing duplicate must not end the next reply early
  const { server, state, url } = await startTts(() => "ok");
  const tts = mk(url);
  const [a, b, c] = await Promise.all([tts.speak("one"), tts.speak("two", { language: "hi-IN" }), tts.synthesize("three")]);
  for (const r of [a, b, c]) assert.equal(r.bytes, 4800, JSON.stringify(r));
  assert.equal(c.audio.length, 4800);
  assert.equal(state.connections, 1); assert.deepEqual(state.requests.map((r) => r.text), ["one", "two", "three"]);
  assert.equal(state.requests[1].language, "hi-IN");
  tts.close(); server.close(); console.log("tts queue + trailing-complete ok");
}
{ // 3. server drops the connection after a reply -> next speak reconnects
  const { server, state, url } = await startTts((n) => (n === 1 ? "close-after" : "ok"));
  const tts = mk(url);
  await tts.speak("first"); await sleep(120);
  const r = await tts.speak("second");
  assert.equal(r.bytes, 4800); assert.equal(state.connections, 2);
  tts.close(); server.close(); console.log("tts reconnect after idle drop ok");
}
{ // 4. connection that died silently: first send gets closed with no audio -> retried once
  const { server, state, url } = await startTts((n) => (n === 1 ? "close-now" : "ok"));
  const tts = mk(url);
  const r = await tts.speak("hello");
  assert.equal(r.bytes, 4800); assert.equal(state.connections, 2);
  tts.close(); server.close(); console.log("tts retry on dead connection ok");
}
{ // 5. error message, 6. timeout
  const e = await startTts(() => "error"); const t1 = mk(e.url);
  await assert.rejects(t1.speak("x"), /bad voice/); t1.close(); e.server.close();
  const s = await startTts(() => "silent"); const t2 = mk(s.url, { requestTimeoutMs: 200 });
  await assert.rejects(t2.speak("x"), /timed out/); t2.close(); s.server.close();
  console.log("tts error + timeout ok");
}
{ // 7. cancel mid-reply, then speak again
  const { server, state, url } = await startTts((n) => (n === 1 ? "slow" : "ok"));
  const tts = mk(url);
  const first = tts.speak("long reply");
  await sleep(170); tts.cancel();
  const r1 = await first;
  assert.equal(r1.cancelled, true); assert.ok(r1.bytes < 4800);
  const r2 = await tts.speak("again");
  assert.equal(r2.bytes, 4800); assert.equal(state.connections, 2);
  tts.close(); server.close(); console.log("tts cancel ok");
}
assert.throws(() => new GnaniTts({ apiKey: null, voice: null }), /GNANI_API_KEY/);

// ---------------- fake Gnani STT server ----------------
{
  const frames = []; let headers = null;
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (ws, req) => {
    headers = req.headers;
    setTimeout(() => ws.send(JSON.stringify({ type: "connected", config: { sample_rate: 16000, language_code: "indic-auto" } })), 60);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      frames.push(Buffer.from(data));
      if (frames.length === 5) {
        ws.send(JSON.stringify({ type: "speech_start", utterance_id: "u1", t_ms: 20 }));
        ws.send(JSON.stringify({ type: "transcript", text: "दाल मखनी 280 रुपये की है।", utterance_id: "u1", is_final: true, latency: 138, audio_duration_ms: 2816, detected_language_code: "hi-IN" }));
        ws.send(JSON.stringify({ type: "transcript", text: "   ", utterance_id: "u2" })); // empty: must be dropped
      }
    });
  });
  await new Promise((r) => server.on("listening", r));
  const stt = new GnaniStt({ apiKey: "KEY", sttUrl: `ws://127.0.0.1:${server.address().port}` });
  const events = [];
  stt.on("speech_start", (e) => events.push(["speech_start", e]));
  stt.on("transcript", (e) => events.push(["transcript", e]));

  // audio written BEFORE the server says "connected" must not be lost
  const pcm = Buffer.alloc(5000, 7);
  stt.write(pcm.subarray(0, 1500)); stt.write(pcm.subarray(1500, 1501 + 2)); stt.write(pcm.subarray(1503));
  await stt.connect();
  stt.flush(); // 5000 bytes = 4 full frames + 904 left over -> padded 5th frame
  await sleep(150);
  assert.equal(frames.length, 5); assert.ok(frames.every((f) => f.length === 1024));
  assert.deepEqual(Buffer.concat(frames).subarray(0, 5000), pcm);
  assert.ok(Buffer.concat(frames).subarray(5000).every((b) => b === 0)); // padding is silence
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], ["speech_start", { utteranceId: "u1" }]);
  const t = events[1][1];
  assert.equal(t.text, "दाल मखनी 280 रुपये की है।"); assert.equal(t.language, "hi-IN");
  assert.equal(t.latencyMs, 138); assert.equal(t.audioMs, 2816); assert.equal(t.isFinal, true);
  assert.equal(headers["x-api-key-id"], "KEY"); assert.equal(headers["language_code"], "indic-auto");
  assert.equal(headers["x-sample-rate"], "8000"); assert.equal(headers["x-min-silence-ms"], "500");
  assert.equal(headers["x-model"], "prisma-v3.0"); assert.equal(headers["model"], "prisma-v3.0");

  // pacing: 3 frames should take about 2 x 64 ms (the first is sent immediately)
  const t0 = Date.now(); await stt.streamRealtime(Buffer.alloc(3 * 1024)); const dt = Date.now() - t0;
  assert.ok(dt >= 170 && dt < 400, "streamRealtime took " + dt);
  stt.close(); server.close();
  console.log("stt ok (paced 3 frames in " + dt + " ms)");
}
{ // connect timeout + bad host
  const server = new WebSocketServer({ port: 0 }); await new Promise((r) => server.on("listening", r));
  const stt = new GnaniStt({ apiKey: "KEY", sttUrl: `ws://127.0.0.1:${server.address().port}` });
  await assert.rejects(stt.connect({ timeoutMs: 200 }), /did not answer/); server.close();
  const stt2 = new GnaniStt({ apiKey: "KEY", sttUrl: "ws://127.0.0.1:1" });
  await assert.rejects(stt2.connect({ timeoutMs: 1000 }));
  console.log("stt timeout + refused ok");
}
console.log("\nALL GNANI MODULE TESTS PASSED");
process.exit(0);
