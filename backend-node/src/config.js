import "dotenv/config";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: process.env.PORT || 5000,
  pythonServiceUrl: (process.env.PYTHON_SERVICE_URL || "http://localhost:8000").replace(/\/$/, ""),
  // The dashboard's origin(s), comma-separated. Both spellings of localhost are allowed by
  // default, because http://localhost:5173 and http://127.0.0.1:5173 are different origins to a browser.
  frontendOrigins: (process.env.FRONTEND_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Protects /api/* and the call-triggering routes (see src/middleware/adminAuth.js).
  adminToken: process.env.ADMIN_TOKEN || null,
  // How long to wait for the Python RAG service to answer a question during a call.
  ragTimeoutMs: Number(process.env.RAG_TIMEOUT_MS || 20000),
  mongodbUri: requireEnv("MONGODB_URI"),
  mongodbDb: process.env.MONGODB_DB || "restaurant_cs_operations",
  // Used to validate that incoming /voice/* webhooks genuinely came from
  // Twilio (via the X-Twilio-Signature header), not a spoofed request.
  twilioAuthToken: requireEnv("TWILIO_AUTH_TOKEN"),

  // Only needed for the outbound test-call trigger (POST
  // /voice/trigger-test-call) — everything else works without these, so
  // they're optional rather than required at boot. All three must be set
  // for that one route to work; it checks and reports clearly if not.
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || null, // your purchased Twilio number, E.164
  testPhoneNumber: process.env.TEST_PHONE_NUMBER || null, // your own verified real phone, E.164
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "") || null, // current ngrok URL
  // Debugging only — disables X-Twilio-Signature validation on /voice/* (see .env).
  skipTwilioValidation: process.env.TWILIO_SKIP_VALIDATION === "true",
  // Language for the call's speech recognition (Gather) and text-to-speech
  // (Say). en-IN matches Indian-English callers; overridable in .env.
  voiceLanguage: process.env.VOICE_LANGUAGE || "en-IN",

  // How calls are handled:
  //   "twilio" - Twilio's own speech recognition and voice (Gather/Say), English only
  //   "gnani"  - a Twilio media stream; Gnani does the listening and speaking (Hindi, Punjabi, English)
  voiceMode: (process.env.VOICE_MODE || "twilio").toLowerCase(),
  // Gnani mode: how long to wait for the caller to say something after the agent
  // finishes speaking, before asking "are you still there?" (then hanging up on the next silence).
  silenceTimeoutMs: Number(process.env.VOICE_SILENCE_TIMEOUT_MS || 10000),
};