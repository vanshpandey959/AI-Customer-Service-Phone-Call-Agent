import crypto from "crypto";
import { Router } from "express";
import twilio from "twilio";
import { config } from "../config.js";
import {
  findOrCreateCallByCallSid,
  getCallByCallSid,
  getHistoryForRag,
  appendTurn,
  markCallEnded,
  reconcileCall,
} from "../callService.js";
import { askRagService } from "../ragClient.js";

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Verifies the X-Twilio-Signature header on every request to these routes,
 * so a request claiming to be a Twilio webhook actually is one.
 *
 * WHY THIS REPLACES the SDK's twilio.webhook(...) middleware: that middleware
 * rebuilds the signed URL from req.protocol/req.host — which behind ngrok or
 * any reverse proxy is the LOCAL http://localhost:5000, while Twilio signed
 * the PUBLIC https URL. The mismatch rejects genuine Twilio requests with
 * 403, and Twilio's reaction to a rejected webhook is to hang the call up
 * silently (the "trial notice, press any key, then it hangs up" symptom).
 * We instead validate against PUBLIC_BASE_URL + the request path — exactly
 * the URL Twilio signed.
 */
function validateTwilioSignature(req, res, next) {
  if (config.skipTwilioValidation) return next();

  const signature = req.header("X-Twilio-Signature");
  const url = signedUrlFor(req);

  if (!signature) {
    console.error(`[twilio] REJECT ${url} — no X-Twilio-Signature header (not a Twilio request).`);
    return res.status(403).send("Twilio signature missing");
  }
  if (!twilio.validateRequest(config.twilioAuthToken, signature, url, req.body)) {
    console.error(
      `[twilio] REJECT ${url} — signature validation failed. Twilio signs the PUBLIC url it ` +
        `called; this server validated against "${url}". If PUBLIC_BASE_URL doesn't match the ` +
        `URL Twilio actually dialed (stale ngrok URL? wrong port?), genuine requests fail here.`
    );
    return res.status(403).send("Twilio signature validation failed");
  }
  next();
}

/** The full public URL Twilio signed for this request. Prefers the explicit
 * PUBLIC_BASE_URL (tunnel/proxy safe), falls back to request-derived values. */
function signedUrlFor(req) {
  const base = config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
  return `${base}${req.originalUrl}`;
}

const GREETING =
  "Thanks for calling Spice Route Kitchen. I can help with the menu, timings, offers, or anything else. What can I do for you?";
const DIDNT_CATCH_THAT = "Sorry, I didn't catch that. Could you repeat it?";
const TROUBLE_RESPONDING =
  "Sorry, I'm having trouble responding right now. Could you repeat that?";

const TERMINAL_CALL_STATUSES = ["completed", "busy", "failed", "no-answer", "canceled"];

function gatherTwiml(sayText) {
  const twiml = new VoiceResponse();
  // language comes from VOICE_LANGUAGE (en-IN by default) so both the voice
  // and the speech recognition match Indian-English callers. Without it,
  // <Say> defaults to an American voice and <Gather> to en-US recognition.
  twiml.say({ language: config.voiceLanguage }, sayText);
  // actionOnEmptyResult ensures /voice/gather still gets hit even if the
  // customer says nothing before the timeout, so we can re-prompt instead
  // of the call silently falling through to a dead end.
  twiml.gather({
    input: "speech",
    action: "/voice/gather",
    method: "POST",
    speechTimeout: "auto",
    actionOnEmptyResult: true,
    language: config.voiceLanguage,
  });
  return twiml.toString();
}

/** Sends TwiML with exactly the headers Twilio requires. */
function sendTwiml(res, twiml) {
  return res.type("text/xml").send(twiml);
}

/**
 * Wraps a route handler so ANY unhandled error still answers with valid
 * TwiML XML. Express's default error response is JSON/HTML, which Twilio
 * cannot parse — it hangs the call up silently. With this wrapper the worst
 * case is the caller hearing the retry prompt instead of dead air.
 */
function twimlRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[twilio] ${req.method} ${req.originalUrl} failed:`, err);
      if (res.headersSent) return res.end();
      sendTwiml(res, gatherTwiml(TROUBLE_RESPONDING));
    }
  };
}

/**
 * Figures out which phone number is "the customer" for storage purposes.
 * For a genuine inbound call, that's whoever dialed in (`From`). For a
 * call WE triggered outbound (via /voice/trigger-test-call, so you can
 * test by having your own phone ring instead of dialing out yourself),
 * Twilio reports Direction as "outbound-api" and `From` is actually your
 * own Twilio number — the real person on the call is whoever it rang,
 * i.e. `To`. Without this check, test calls would get callerNumber
 * backwards in the admin dashboard (a cosmetic issue, not a functional
 * one — the conversation itself works identically either way).
 */
function getCustomerNumber(body) {
  return body.Direction === "inbound" ? body.From : body.To;
}

/** Twilio hits this the moment someone dials the number (or a triggered test call connects). */
router.post("/incoming", validateTwilioSignature, twimlRoute(async (req, res) => {
  const callSid = req.body.CallSid;
  const callerNumber = getCustomerNumber(req.body);

  try {
    await findOrCreateCallByCallSid(callSid, callerNumber);
  } catch (err) {
    console.error("Error creating call from Twilio webhook:", err.message);
    // Still greet the caller even if the DB write failed — better than
    // silence, and the call can still proceed (though this turn's history
    // won't be saved if the DB is genuinely down).
  }

  sendTwiml(res, gatherTwiml(GREETING));
}));

/** Twilio hits this after gathering (or failing to gather) speech input. */
router.post("/gather", validateTwilioSignature, twimlRoute(async (req, res) => {
  const { CallSid: callSid, SpeechResult: speechResult } = req.body;

  const call = await getCallByCallSid(callSid);
  if (!call || call.status === "ended") {
    // Shouldn't normally happen — the call ended or was never tracked.
    const twiml = new VoiceResponse();
    twiml.say({ language: config.voiceLanguage }, "Sorry, something went wrong with this call. Goodbye.");
    twiml.hangup();
    return sendTwiml(res, twiml.toString());
  }

  if (!speechResult || !speechResult.trim()) {
    return sendTwiml(res, gatherTwiml(DIDNT_CATCH_THAT));
  }

  const historyBeforeThisTurn = await getHistoryForRag(call._id.toString());
  const trimmedMessage = speechResult.trim();
  const { answer, classification } = await askRagService(trimmedMessage, historyBeforeThisTurn);
  await appendTurn(call._id.toString(), trimmedMessage, answer, classification);

  sendTwiml(res, gatherTwiml(answer));
}));

/**
 * Twilio hits this whenever the call's status changes (configured
 * separately as "Call status changes" on the number). This is what
 * triggers end-of-call reconciliation for real phone calls — a more
 * reliable signal than the web frontend's /api/chat/end, since it fires
 * for any real call ending (hangup, failure, no-answer), not just a
 * clean button click.
 */
router.post("/status", validateTwilioSignature, twimlRoute(async (req, res) => {
  const { CallSid: callSid, CallStatus: callStatus } = req.body;

  // Always acknowledge — Twilio doesn't need TwiML here, and our own
  // reconciliation errors shouldn't surface as a failed webhook to Twilio.
  res.sendStatus(200);

  if (!TERMINAL_CALL_STATUSES.includes(callStatus)) return;

  const call = await getCallByCallSid(callSid);
  if (!call || call.reconciledAt) return; // unknown call, or already handled

  if (call.status !== "ended") {
    await markCallEnded(call._id.toString());
  }
  await reconcileCall(call._id.toString());
}));

/**
 * Preflight diagnostic — run this before triggering a test call:
 *
 *   curl http://localhost:5000/voice/selfcheck
 *
 * It replays, from the server itself, exactly what Twilio does after the
 * trial-notice keypress: a form-encoded, correctly-signed POST to
 * PUBLIC_BASE_URL/voice/incoming — plus a health check on the Python RAG
 * service. Every way this probe can fail is a way the real call can fail,
 * so it catches the "connects, trial message, then hang up" bugs without
 * spending any call credit.
 */
router.get("/selfcheck", twimlRoute(async (req, res) => {
  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    webhookUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/voice/incoming` : null,
    checks: [],
  };

  const required = {
    TWILIO_ACCOUNT_SID: config.twilioAccountSid,
    TWILIO_AUTH_TOKEN: config.twilioAuthToken,
    TWILIO_PHONE_NUMBER: config.twilioPhoneNumber,
    TEST_PHONE_NUMBER: config.testPhoneNumber,
    PUBLIC_BASE_URL: config.publicBaseUrl,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  report.checks.push({
    name: "env-vars",
    ok: missing.length === 0,
    detail: missing.length === 0
      ? "All required env vars are set."
      : `Missing env vars: ${missing.join(", ")}`,
    fix: missing.length === 0 ? undefined : `Set the missing vars in backend-node/.env and restart the server.`,
  });

  report.checks.push({
    name: "signature-validation",
    ok: true,
    detail: config.skipTwilioValidation
      ? "DISABLED (TWILIO_SKIP_VALIDATION=true) — webhooks accept anyone. Re-enable after debugging."
      : "Enabled — the webhook POST below is signed with the exact algorithm Twilio uses, so it exercises the real code path.",
  });

  if (missing.length === 0) {
    // 1. Replay what Twilio does after the keypress: signed form POST.
    const url = `${config.publicBaseUrl}/voice/incoming`;
    const params = {
      CallSid: `CAsimulated-selfcheck-${Date.now()}`,
      CallStatus: "ringing",
      Direction: "outbound-api",
      From: config.twilioPhoneNumber,
      To: config.testPhoneNumber,
    };
    // Twilio's signing algorithm: base64(HMAC-SHA1(authToken, url + the
    // alphabetically sorted "keyvalue" concatenation of the form params)).
    const signature = crypto
      .createHmac("sha1", config.twilioAuthToken)
      .update(url + Object.keys(params).sort().map((k) => k + params[k]).join(""), "utf-8")
      .digest("base64");

    try {
      const started = Date.now();
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": signature,
          "User-Agent": "TwilioProxy/1.1 (+https://www.twilio.com/docs/usage/security)",
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(8000),
      });
      const body = await resp.text();
      const ms = Date.now() - started;
      const isTwiml = resp.ok && body.trimStart().startsWith("<?xml");

      report.checks.push({
        name: "webhook-reachable",
        ok: isTwiml,
        detail: isTwiml
          ? `POST ${url} → 200 with valid TwiML in ${ms}ms — exactly what Twilio needs after the keypress.`
          : `POST ${url} → HTTP ${resp.status} (${ms}ms), body started with: ${body.slice(0, 80).replace(/\s+/g, " ")}`,
        fix: isTwiml
          ? undefined
          : !resp.ok
          ? resp.status === 403
            ? "Signature rejected. The server must validate against PUBLIC_BASE_URL + the request path — make sure the URL this test used matches PUBLIC_BASE_URL in .env and that TWILIO_AUTH_TOKEN belongs to the Twilio account making the calls."
            : "The webhook did not return 200. If this ran through ngrok: is the tunnel still alive, and is PUBLIC_BASE_URL the CURRENT tunnel URL? Free ngrok URLs change on every restart."
          : "Got 200 but not TwiML XML — something between Twilio and this server answered instead (proxy/tunnel interstitial page). Twilio requires 200 + text/xml.",
      });
      report.note = `The simulated webhook creates one test call record (CallSid ${params.CallSid}) in the dashboard — safe to delete.`;
    } catch (err) {
      report.checks.push({
        name: "webhook-reachable",
        ok: false,
        detail: `POST ${url} failed: ${err.message}`,
        fix: "The URL is not reachable — almost always a stale ngrok tunnel or PUBLIC_BASE_URL pointing at an old URL. Restart ngrok, copy the new https URL into backend-node/.env, restart the node backend.",
      });
    }

    // 2. The Python RAG service — if it's down, calls still connect and the
    //    agent still speaks the greeting, but every answer fails.
    try {
      const resp = await fetch(`${config.pythonServiceUrl}/health`, { signal: AbortSignal.timeout(3000) });
      report.checks.push({
        name: "rag-service",
        ok: resp.ok,
        detail: `GET ${config.pythonServiceUrl}/health → ${resp.status}`,
        fix: resp.ok ? undefined : "The Python RAG service responded, but not OK. Check its terminal and its own .env.",
      });
    } catch (err) {
      report.checks.push({
        name: "rag-service",
        ok: false,
        detail: `GET ${config.pythonServiceUrl}/health failed: ${err.message}`,
        fix: "The Python RAG service isn't running. Start it (uvicorn main:app --port 8000) — without it calls connect, but every answer fails.",
      });
    }
  }

  report.ok = report.checks.every((c) => c.ok);
  report.nextStep = report.ok
    ? "All checks passed — trigger the call from the dashboard, answer, press any key at the trial notice, and the agent will speak."
    : "Fix the failing check(s) above (each has a 'fix' hint), then re-run the selfcheck before triggering a call.";

  res.json(report);
}));

/**
 * Triggers an OUTBOUND call from your Twilio number to your own real
 * phone (config.testPhoneNumber) — so you can test the full voice flow
 * by answering an incoming call on your actual phone, without dialing
 * internationally yourself. You (the receiver) are never charged for an
 * incoming call regardless of where it originates — the caller (Twilio,
 * here) is who's billed, and that cost comes out of your existing Twilio
 * account balance, same as any other call this project makes. No
 * external carrier is billed on either end.
 *
 * Deliberately takes no request body — the destination number always
 * comes from config (TEST_PHONE_NUMBER), never from client input, so
 * this can't be used to place a call to an arbitrary number even if
 * someone else found this endpoint. On a trial account, Twilio also
 * independently refuses to call any number that isn't verified, which
 * is a second, Twilio-enforced backstop on top of this.
 */
router.post("/trigger-test-call", twimlRoute(async (req, res) => {
  const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber, testPhoneNumber, publicBaseUrl } = config;

  const missing = [];
  if (!twilioAccountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!twilioAuthToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!twilioPhoneNumber) missing.push("TWILIO_PHONE_NUMBER");
  if (!testPhoneNumber) missing.push("TEST_PHONE_NUMBER");
  if (!publicBaseUrl) missing.push("PUBLIC_BASE_URL");

  if (missing.length > 0) {
    return res.status(500).json({
      error: `Missing required env var(s) for trigger-test-call: ${missing.join(", ")}`,
    });
  }

  try {
    const client = twilio(twilioAccountSid, twilioAuthToken);
    const call = await client.calls.create({
      to: testPhoneNumber,
      from: twilioPhoneNumber,
      url: `${publicBaseUrl}/voice/incoming`,
      statusCallback: `${publicBaseUrl}/voice/status`,
      statusCallbackEvent: ["completed"],
    });

    console.log(`[twilio] call ${call.sid} triggered → webhook ${publicBaseUrl}/voice/incoming`);
    res.json({
      triggered: true,
      callSid: call.sid,
      status: call.status,
      // surfaced so the response itself shows which URL Twilio will fetch —
      // if a call hangs up after the trial keypress, check THIS first.
      webhookUrl: `${publicBaseUrl}/voice/incoming`,
      hint: "Answer, press any key at the trial notice, and the agent speaks. If it still hangs up: run GET /voice/selfcheck, then check Twilio Console → Monitor → Debugger for the exact webhook error.",
    });
  } catch (err) {
    console.error("Error triggering test call:", err.message);
    res.status(502).json({
      error: `Twilio rejected the call request: ${err.message}`,
      code: err.code || null,
    });
  }
}));

export default router;
