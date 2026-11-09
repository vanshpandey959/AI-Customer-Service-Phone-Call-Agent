// Which language is the caller speaking? Decided from the SCRIPT of the transcript,
// because Gnani's per-utterance language tag flips on mixed Hindi/English speech.

const CODES = { en: "en-IN", hi: "hi-IN", pa: "pa-IN" };

function letterShares(text) {
  let total = 0;
  let devanagari = 0;
  let gurmukhi = 0;
  let latin = 0;
  for (const ch of text) {
    // letters (L) and combining vowel signs (M); digits and punctuation are ignored
    if (!/[\p{L}\p{M}]/u.test(ch)) continue;
    total += 1;
    const code = ch.codePointAt(0);
    if (code >= 0x0900 && code <= 0x097f) devanagari += 1;
    else if (code >= 0x0a00 && code <= 0x0a7f) gurmukhi += 1;
    else if (code < 0x250) latin += 1;
  }
  if (!total) return null;
  return { devanagari: devanagari / total, gurmukhi: gurmukhi / total, latin: latin / total };
}

/** "pa" | "hi" | "en" from the script of `text`, or null if there are no letters. Hindi/English mixes count as Hindi. */
export function detectScriptLanguage(text) {
  const shares = letterShares(text || "");
  if (!shares) return null;
  if (shares.gurmukhi >= 0.3) return "pa";
  if (shares.devanagari >= 0.2) return "hi";
  if (shares.latin >= 0.8) return "en";
  return null;
}

/**
 * The language the conversation continues in, as a code like "hi-IN".
 *  - Devanagari or Gurmukhi in the utterance switches the conversation to Hindi or Punjabi.
 *  - English switches it only for a real sentence (4+ words): a bare "okay" or "yes"
 *    in the middle of a Hindi call must not flip it.
 *  - With no usable script (e.g. only digits), the previous language is kept.
 */
export function nextConversationLanguage(currentCode, text, gnaniTag) {
  const base = (code) => (code ? code.split("-")[0].toLowerCase() : null);
  let language = base(currentCode);
  const script = detectScriptLanguage(text);

  if (script === "pa" || script === "hi") {
    language = script;
  } else if (script === "en") {
    const words = (text || "").trim().split(/\s+/).length;
    if (!language || words >= 4) language = "en";
  } else if (!language) {
    language = base(gnaniTag) || "en";
  }
  return CODES[language] || "en-IN";
}

/** Did the caller say goodbye? ("bye", "goodbye", अलविदा, ਅਲਵਿਦਾ ...). Deliberately conservative. */
export function isGoodbye(text) {
  const t = text || "";
  if (/\b(bye|goodbye)\b/i.test(t)) return true;
  return /(^|[\s,।.!?])(बाय|अलविदा|ਅਲਵਿਦਾ|ਬਾਏ)(?=$|[\s,।.!?])/u.test(t);
}