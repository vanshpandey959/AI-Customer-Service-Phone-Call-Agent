// Settings for the Gnani speech APIs. Kept separate from src/config.js on purpose:
// this file needs none of the Mongo/Twilio variables, so the Gnani test scripts
// run on their own with just a .env containing the GNANI_* values.
import "dotenv/config";

export const gnaniConfig = {
  apiKey: process.env.GNANI_API_KEY || null,
  voice: process.env.GNANI_VOICE || null, // the exact voice name you picked in the playground

  // Text to speech (WebSocket streaming, phone-format audio)
  ttsUrl: process.env.GNANI_TTS_URL || "wss://api.vachana.ai/api/v1/tts",
  ttsModel: process.env.GNANI_TTS_MODEL || "timbre-v3.0",
  ttsSpeed: Number(process.env.GNANI_TTS_SPEED || 1.0),

  // Speech to text (WebSocket streaming)
  sttUrl: process.env.GNANI_STT_URL || "wss://api.vachana.ai/stt/v3/stream",
  sttModel: process.env.GNANI_STT_MODEL || "prisma-v3.0",
  sttFormat: process.env.GNANI_STT_FORMAT || "transcribe",
  sttLanguage: process.env.GNANI_STT_LANGUAGE || "indic-auto", // auto-detect per utterance
  sampleRate: 8000, // phone audio
  vadThreshold: process.env.GNANI_VAD_THRESHOLD || "0.7",
  minSpeechMs: process.env.GNANI_MIN_SPEECH_MS || "200",
  minSilenceMs: process.env.GNANI_MIN_SILENCE_MS || "500", // silence that ends an utterance
};