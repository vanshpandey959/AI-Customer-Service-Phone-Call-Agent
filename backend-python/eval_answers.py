"""
Compares Groq models on the real task: answer phone-style questions in English,
Hindi, Hinglish and Punjabi from the knowledge base, and classify complaints.

For every question it checks:
  language  - the reply is written in the expected script
  fact      - the reply contains the right fact (a price, time, number...)
  style     - speakable: no markdown/symbols/"Rs."/"%", and short
  class     - complaint / feedback / normal label is right
  json      - the model returned valid JSON (otherwise the app falls back)
Retrieval runs once per question, so every model sees identical context.

Usage (needs ingest + vector index, like eval_retrieval.py):
    python eval_answers.py --quick              # 10 balanced questions, all default models (saves free-tier quota)
    python eval_answers.py                      # all 20 questions
    python eval_answers.py --quick --models openai/gpt-oss-120b,openai/gpt-oss-20b
    python eval_answers.py --limit 6            # first 6 questions only
    python eval_answers.py --verbose            # print every answer, not just failures

By default the model from your .env (GROQ_MODEL) is tested first, then the others.
A model your key cannot use (or whose daily limit is used up) is reported and
skipped; whatever it finished before that still appears in the summary.
"""

import re
import sys
import time
import unicodedata

DEFAULT_MODELS = [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "qwen/qwen3.8-27b",
]

HI_Q1 = "दाल मखनी कितने रुपये की है?"

# id, question, history, conversation language, expected script, facts (any one must appear),
# expected classification, forbidden text (none of these may appear)
CASES = [
    dict(id="en-friday-close", q="What time do you close on Friday?", lang="en-IN", script="latin",
         facts=["midnight", "12 AM", "12:00 AM", "12 PM at night"], cls="normal"),
    dict(id="en-butter-chicken", q="How much is the butter chicken with naan?", lang="en-IN", script="latin",
         facts=["420", "four hundred twenty", "four hundred and twenty"], cls="normal"),
    dict(id="en-alcohol", q="Do you serve alcohol?", lang="en-IN", script="latin",
         facts=["don't", "do not", "not serve", "don’t", "no alcohol"], cls="normal"),
    dict(id="en-unknown-sushi", q="Do you serve sushi?", lang="en-IN", script="latin",
         facts=["don't", "do not", "not", "sorry", "staff"], cls="normal", forbid_digits=True),
    dict(id="hi-dal-price", q=HI_Q1, lang="hi-IN", script="devanagari",
         facts=["280", "दो सौ अस्सी"], cls="normal"),
    dict(id="hi-closing", q="आप लोग रात को कितने बजे बंद होते हैं?", lang="hi-IN", script="devanagari",
         facts=["11:30", "11.30", "साढ़े ग्यारह", "साढ़े 11"], cls="normal"),
    dict(id="hi-unknown-sushi", q="क्या आपके यहाँ सुशी मिलती है?", lang="hi-IN", script="devanagari",
         facts=["नहीं", "माफ़", "स्टाफ़", "स्टाफ"], cls="normal", forbid_digits=True),
    dict(id="hi-booking", q="मुझे weekend के लिए table book करना है", lang="hi-IN", script="devanagari",
         facts=["172", "98765", "WhatsApp", "व्हाट्सऐप", "फ़ोन", "फोन", "call", "कॉल", "स्टाफ"], cls="normal",
         forbid=["बुक कर दी", "बुक हो गई", "book कर दी", "booked", "बुक कर लिया"]),
    dict(id="hinglish-brunch", q="Sunday को brunch होता है क्या, कितने का है?", lang="hi-IN", script="devanagari",
         facts=["599", "749", "पाँच सौ निन्यानवे", "पांच सौ निन्यानवे", "सात सौ उनचास"], cls="normal"),
    dict(id="hi-followup-half", q="और हाफ प्लेट?", lang="hi-IN", script="devanagari",
         history=[dict(role="user", content=HI_Q1), dict(role="assistant", content="दाल मखनी 280 रुपये की है।")],
         facts=["180", "एक सौ अस्सी"], cls="normal"),
    dict(id="en-followup-tikka", q="and Chicken Tikka?", lang="en-IN", script="latin",
         history=[dict(role="user", content="How much is Paneer Tikka?"),
                  dict(role="assistant", content="Paneer Tikka is 280 rupees.")],
         facts=["330", "three hundred thirty", "three hundred and thirty"], cls="normal"),
    dict(id="hi-thanks", q="ठीक है, धन्यवाद", lang="hi-IN", script="devanagari",
         facts=[""], cls="normal"),
    dict(id="pa-dal-price", q="ਦਾਲ ਮੱਖਣੀ ਦਾ ਰੇਟ ਕੀ ਹੈ?", lang="pa-IN", script="gurmukhi",
         facts=["280", "ਦੋ ਸੌ ਅੱਸੀ", "ਦੋ ਸੌ ਅਸੀ"], cls="normal"),
    dict(id="pa-delivery", q="ਕੀ ਤੁਸੀਂ ਘਰ ਡਿਲੀਵਰੀ ਕਰਦੇ ਹੋ?", lang="pa-IN", script="gurmukhi",
         facts=["6", "ਛੇ", "ਹਾਂ"], cls="normal"),
    dict(id="pa-student", q="ਵਿਦਿਆਰਥੀਆਂ ਲਈ ਕੋਈ ਛੋਟ ਹੈ?", lang="pa-IN", script="gurmukhi",
         facts=["10", "ਦਸ"], cls="normal"),
    dict(id="en-complaint", q="The paneer was stale and the waiter was rude when I visited yesterday.",
         lang="en-IN", script="latin", facts=[""], cls="complaint"),
    dict(id="hi-complaint", q="कल हमारा खाना बहुत ठंडा आया और सर्विस भी बहुत धीमी थी।", lang="hi-IN",
         script="devanagari", facts=[""], cls="complaint"),
    dict(id="pa-complaint", q="ਕੱਲ੍ਹ ਖਾਣਾ ਬਹੁਤ ਲੇਟ ਆਇਆ ਤੇ ਠੰਡਾ ਸੀ।", lang="pa-IN", script="gurmukhi",
         facts=[""], cls="complaint"),
    dict(id="hi-feedback", q="आपका बटर चिकन बहुत ही शानदार था, मज़ा आ गया।", lang="hi-IN",
         script="devanagari", facts=[""], cls="feedback"),
    dict(id="en-feedback", q="I think you should add more vegan desserts.", lang="en-IN",
         script="latin", facts=[""], cls="feedback"),
]

# --quick: 10 questions covering every language, a made-up-answer trap, a booking trap,
# a follow-up, and all three classification labels.
QUICK_IDS = [
    "en-butter-chicken", "en-unknown-sushi", "en-complaint",
    "hi-dal-price", "hi-booking", "hi-followup-half", "hi-feedback",
    "hinglish-brunch",
    "pa-dal-price", "pa-complaint",
]

SCRIPT_MIN_SHARE = {"latin": 0.9, "devanagari": 0.5, "gurmukhi": 0.4}
MAX_WORDS = 70
STYLE_PATTERNS = [r"[*#•_`]", r"(?m)^\s*[-•]\s", "₹", r"\bRs\b\.?", "%", r"[\U0001F300-\U0001FAFF\u2600-\u27BF]"]


def script_share(text: str, script: str) -> float:
    """Share of the reply's letters written in the given script."""
    # Category L = letters, M = combining marks (Hindi/Punjabi vowel signs are marks, not letters).
    letters = [c for c in text if unicodedata.category(c)[0] in "LM"]
    if not letters:
        return 0.0
    if script == "devanagari":
        hit = [c for c in letters if "\u0900" <= c <= "\u097F"]
    elif script == "gurmukhi":
        hit = [c for c in letters if "\u0A00" <= c <= "\u0A7F"]
    else:
        hit = [c for c in letters if c.isascii()]
    return len(hit) / len(letters)


def style_problems(text: str) -> list[str]:
    problems = [p for p in STYLE_PATTERNS if re.search(p, text)]
    if len(text.split()) > MAX_WORDS:
        problems.append(f">{MAX_WORDS} words")
    return problems


def check_case(case: dict, result: dict) -> dict:
    """Returns {check_name: bool} for one answer."""
    answer = result["answer"]
    lowered = answer.lower()
    facts = [f for f in case["facts"] if f]
    fact_ok = (not facts) or any(f.lower() in lowered for f in facts)
    if case.get("forbid_digits") and re.search(r"\d", answer):
        fact_ok = False
    if any(f.lower() in lowered for f in case.get("forbid", [])):
        fact_ok = False
    return {
        "language": script_share(answer, case["script"]) >= SCRIPT_MIN_SHARE[case["script"]],
        "fact": fact_ok,
        "style": not style_problems(answer),
        "class": result["classification"] == case["cls"],
        "json": bool(result.get("json_ok", True)),
    }


def call_with_retry(fn, attempts: int = 3):
    """Groq's free tier rate-limits quickly: wait and retry on 429s."""
    for attempt in range(attempts):
        try:
            return fn()
        except Exception as exc:
            text = str(exc).lower()
            if "per day" in text or "tpd" in text:
                raise  # daily quota used up: waiting 20 seconds will not help
            if attempt < attempts - 1 and ("429" in text or "rate limit" in text or "rate_limit" in text):
                time.sleep(20 * (attempt + 1))
                continue
            raise


def main() -> None:
    args = sys.argv[1:]
    # imported here so the helper functions above can be tested without a database
    from config import GROQ_MODEL
    from rag import build_search_query, generate_answer, retrieve_context

    models = [GROQ_MODEL] + [m for m in DEFAULT_MODELS if m != GROQ_MODEL]
    if "--models" in args:
        models = [m.strip() for m in args[args.index("--models") + 1].split(",") if m.strip()]
    cases = CASES
    if "--quick" in args:
        cases = [c for c in CASES if c["id"] in QUICK_IDS]
    if "--limit" in args:
        cases = cases[: int(args[args.index("--limit") + 1])]
    verbose = "--verbose" in args

    print(f"Retrieving context for {len(cases)} questions...")
    contexts = []
    for case in cases:
        contexts.append(retrieve_context(build_search_query(case["q"], case.get("history"))))

    summary = {}
    for model in models:
        print(f"\n=== {model} ===")
        stats = {"n": 0, "language": 0, "fact": 0, "style": 0, "class": 0, "json": 0, "seconds": 0.0}
        skipped = None
        for case, chunks in zip(cases, contexts):
            history = case.get("history")
            start = time.time()
            try:
                result = call_with_retry(
                    lambda: generate_answer(case["q"], chunks, history, case["lang"], model=model)
                )
            except Exception as exc:
                skipped = str(exc).splitlines()[0][:160]
                break
            elapsed = time.time() - start

            checks = check_case(case, result)
            stats["n"] += 1
            stats["seconds"] += elapsed
            for key, ok in checks.items():
                stats[key] += int(ok)

            failed = [k for k, ok in checks.items() if not ok]
            if failed or verbose:
                flag = "FAIL " + ",".join(failed) if failed else "ok"
                print(f"[{flag}] {case['id']} ({elapsed:.1f}s) -> {result['classification']}")
                print(f"        {result['answer']}")
            time.sleep(1.5)  # stay under free-tier request limits

        if skipped:
            print(f"STOPPED after {stats['n']} of {len(cases)} questions: {skipped}")
        if stats["n"]:
            summary[model] = stats

    print("\n=== Summary (checks passed) ===")
    header = f"{'model':<28}{'lang':>6}{'fact':>6}{'style':>7}{'class':>7}{'json':>6}{'avg s':>8}"
    print(header)
    for model, s in summary.items():
        n = max(s["n"], 1)
        print(
            f"{model:<28}{s['language']:>3}/{s['n']:<2}{s['fact']:>3}/{s['n']:<2}{s['style']:>4}/{s['n']:<2}"
            f"{s['class']:>4}/{s['n']:<2}{s['json']:>3}/{s['n']:<2}{s['seconds'] / n:>7.1f}"
        )


if __name__ == "__main__":
    main()