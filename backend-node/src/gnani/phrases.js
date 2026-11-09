// The few fixed lines the agent says itself (everything else is written by the LLM).
// Spoken by Gnani TTS with language "auto", so each line is written in its own script.
// Have a native speaker check the Hindi and Punjabi wording before a demo.

const PHRASES = {
  // Said when the call starts, before we know the caller's language.
  greeting:
    "Thanks for calling Chandigarh Cafe and Restaurant. आप हिंदी, पंजाबी या English में बात कर सकते हैं। How can I help you?",

  didntCatch: {
    en: "Sorry, I didn't catch that. Could you repeat it?",
    hi: "माफ़ कीजिए, मैं समझ नहीं पाई। क्या आप दोबारा बता सकते हैं?",
    pa: "ਮਾਫ਼ ਕਰਨਾ, ਮੈਂ ਸਮਝ ਨਹੀਂ ਸਕੀ। ਕੀ ਤੁਸੀਂ ਦੁਬਾਰਾ ਦੱਸ ਸਕਦੇ ਹੋ?",
  },
  trouble: {
    en: "Sorry, I'm having trouble responding right now. Could you repeat that?",
    hi: "माफ़ कीजिए, मुझे अभी जवाब देने में दिक्कत हो रही है। क्या आप दोबारा बता सकते हैं?",
    pa: "ਮਾਫ਼ ਕਰਨਾ, ਮੈਨੂੰ ਹੁਣ ਜਵਾਬ ਦੇਣ ਵਿੱਚ ਦਿੱਕਤ ਆ ਰਹੀ ਹੈ। ਕੀ ਤੁਸੀਂ ਦੁਬਾਰਾ ਦੱਸ ਸਕਦੇ ਹੋ?",
  },
  stillThere: {
    en: "Are you still there?",
    hi: "क्या आप अभी भी लाइन पर हैं?",
    pa: "ਕੀ ਤੁਸੀਂ ਅਜੇ ਵੀ ਲਾਈਨ 'ਤੇ ਹੋ?",
  },
  goodbyeSilence: {
    en: "I'll end the call for now. Thank you for calling Chandigarh Cafe and Restaurant. Goodbye!",
    hi: "मैं अभी कॉल बंद कर रही हूँ। चंडीगढ़ कैफ़े एंड रेस्टोरेंट को कॉल करने के लिए धन्यवाद। नमस्ते!",
    pa: "ਮੈਂ ਹੁਣ ਕਾਲ ਬੰਦ ਕਰ ਰਹੀ ਹਾਂ। ਕਾਲ ਕਰਨ ਲਈ ਧੰਨਵਾਦ। ਸਤ ਸ੍ਰੀ ਅਕਾਲ!",
  },
};

/** phrase("stillThere", "hi-IN") -> the Hindi line. Falls back to English. */
export function phrase(key, languageCode = "en-IN") {
  const entry = PHRASES[key];
  if (typeof entry === "string") return entry;
  const base = (languageCode || "en").split("-")[0].toLowerCase();
  return entry[base] || entry.en;
}