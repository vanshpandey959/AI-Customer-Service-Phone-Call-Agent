// Checks the HTTP side without MongoDB, Twilio or Gnani: admin-token protection, a database error
// returning 500 instead of crashing the process, and /voice/selfcheck in VOICE_MODE=gnani.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// fake Gnani TTS (accepts the connection) and fake Python service (/health)
const tts = new WebSocketServer({ port: 0 }); await new Promise((r) => tts.on("listening", r));
const python = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end('{"status":"ok"}'); });
await new Promise((r) => python.listen(0, r));
const appPort = await freePort();

Object.assign(process.env, {
  MONGODB_URI: "mongodb://localhost/unused", TWILIO_AUTH_TOKEN: "tok", TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_PHONE_NUMBER: "+15550001", TEST_PHONE_NUMBER: "+919800000000", ADMIN_TOKEN: "secret",
  PUBLIC_BASE_URL: `http://127.0.0.1:${appPort}`, VOICE_MODE: "gnani", GNANI_API_KEY: "k", GNANI_VOICE: "v",
  GNANI_TTS_URL: `ws://127.0.0.1:${tts.address().port}`, PYTHON_SERVICE_URL: `http://127.0.0.1:${python.address().port}`,
});

const mongoose = (await import("mongoose")).default;
mongoose.set("bufferTimeoutMS", 200); // no database here: queries fail fast
const express = (await import("express")).default;
const cors = (await import("cors")).default;
const { config } = await import("../src/config.js");
const { requireAdmin } = await import("../src/middleware/adminAuth.js");
const { default: recordsRouter } = await import("../src/routes/records.js");
const { default: voiceRouter } = await import("../src/routes/voice.js");
const { attachVoiceStream } = await import("../src/voiceStream.js");

// the same wiring as server.js
const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: config.frontendOrigins }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/api", requireAdmin, recordsRouter);
app.use("/voice", voiceRouter);
app.use((err, req, res, next) => res.status(500).json({ error: "Something went wrong." }));
const server = http.createServer(app);
attachVoiceStream(server);
await new Promise((r) => server.listen(appPort, r));
const base = `http://127.0.0.1:${appPort}`;

let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);

// ---- admin token ----
assert.equal((await fetch(`${base}/api/calls`)).status, 401);
assert.equal((await fetch(`${base}/api/calls`, { headers: { "x-admin-token": "wrong" } })).status, 401);
assert.equal((await fetch(`${base}/voice/trigger-test-call`, { method: "POST" })).status, 401);
assert.equal((await fetch(`${base}/voice/selfcheck`)).status, 401);
// with the token the request is let through; the database is missing, so it must be a clean 500, not a crash
for (const headers of [{ "x-admin-token": "secret" }, { authorization: "Bearer secret" }]) {
  const r = await fetch(`${base}/api/calls`, { headers });
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: "Something went wrong." });
}
assert.equal((await fetch(`${base}/api/complaints?token=secret`)).status, 500);
assert.equal((await fetch(`${base}/api/calls/not-an-id`, { headers: { "x-admin-token": "secret" } })).status, 400);
// still alive after several database failures, and nothing escaped as an unhandled rejection
assert.equal((await fetch(`${base}/api/calls`)).status, 401);
assert.equal(unhandled, 0, "an error escaped as an unhandled rejection");
// CORS: both spellings of localhost are allowed, other origins are not
for (const [origin, allowed] of [["http://localhost:5173", true], ["http://127.0.0.1:5173", true], ["http://evil.example", false]]) {
  const r = await fetch(`${base}/api/calls`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "x-admin-token" } });
  assert.equal(r.headers.get("access-control-allow-origin") === origin, allowed, origin);
}
console.log("admin token, 500-not-crash and CORS ok");

// ---- selfcheck in gnani mode ----
const report = await (await fetch(`${base}/voice/selfcheck?token=secret`)).json();
const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
for (const name of ["env-vars", "signature-validation", "voice-mode", "webhook-reachable", "media-stream-websocket", "gnani-api", "rag-service"]) {
  assert.ok(byName[name], "missing check " + name);
  assert.equal(byName[name].ok, true, `${name}: ${byName[name].detail}`);
}
assert.equal(report.ok, true);
assert.match(byName["media-stream-websocket"].detail, /<token>/);
assert.ok(!byName["media-stream-websocket"].detail.includes("CAselfcheck."), "the token must not be echoed");
console.log("selfcheck ok:", report.checks.map((c) => c.name).join(", "));
console.log("\nSERVER TESTS PASSED");
process.exit(0);
