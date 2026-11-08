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
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
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
};
