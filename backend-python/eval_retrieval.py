"""
Retrieval test for the knowledge base: for each question, does the right chunk
come back in the top results?

A question counts as a HIT when some retrieved chunk contains ALL of its
'must contain' strings (case-insensitive). The rank is the position of the
first such chunk. A case may list several alternative string-lists (for example
the English line AND the Hindi/Punjabi summary line): a chunk matching ANY of
them counts, because the answer is equally correct in any language.

Usage (after ingest + index creation):
    python eval_retrieval.py            # top 5
    python eval_retrieval.py --k 3
    python eval_retrieval.py --check-kb # only verify the expected strings exist in the KB (no Mongo needed)
"""

import sys
from collections import defaultdict
from pathlib import Path

KB_FILE = "knowledge/chandigarh_cafe_and_restaurant_kb.md"

# (language, question, [strings that must all appear in one retrieved chunk])
CASES = [
    # --- English ---
    ("en", "What time do you open and close?", ["8:00 AM", "11:30 PM"]),
    ("en", "How much is Dal Makhani?", ["Dal Makhani", "Rs. 280"]),
    ("en", "What is the price of Chicken Biryani?", ["Chicken Biryani", "Rs. 360"]),
    ("en", "Where is the restaurant located?", ["Sector 17-C"]),
    ("en", "Is there parking available?", ["parking"]),
    ("en", "Do you serve alcohol?", ["alcohol"]),
    ("en", "Do you have breakfast?", ["Breakfast", "8:00 AM"]),
    ("en", "How much is the Sunday brunch buffet?", ["Brunch", "Rs. 599"]),
    ("en", "What winter specials do you have?", ["Winter", "Sarson da Saag"]),
    ("en", "How can I make a complaint?", ["complaint", "Guest Relations"]),
    # --- Hindi (Devanagari, the way Gnani STT writes it) ---
    ("hi", "दाल मखनी कितने रुपये की है?", ["Dal Makhani", "Rs. 280"]),
    ("hi", "आपका रेस्टोरेंट कितने बजे खुलता है?", [["8:00 AM", "11:30 PM"], ["8:00 बजे", "11:30 बजे"]]),
    ("hi", "पनीर बटर मसाला का रेट बताइए", ["Paneer Butter Masala", "Rs. 340"]),
    ("hi", "क्या आप होम डिलीवरी करते हैं?", [["home delivery", "6 km"], ["होम डिलीवरी", "6 किलोमीटर"]]),
    ("hi", "मंगलवार को कोई ऑफर है क्या?", [["Tuesday", "20%"], ["मंगलवार", "20%"]]),
    ("hi", "जैन खाना मिलेगा क्या?", ["Jain"]),
    ("hi", "पार्किंग की सुविधा है क्या?", ["parking"]),
    ("hi", "लस्सी कितने की है?", ["Sweet Lassi", "Rs. 110"]),
    # --- Hinglish (Hindi written in Latin script) ---
    ("hinglish", "Butter chicken ka price kya hai?", ["Butter Chicken", "Rs. 420"]),
    ("hinglish", "Sunday ko brunch hota hai kya?", ["Brunch", "Sunday"]),
    ("hinglish", "Weekend ke liye table book karna hai", [["reservation", "weekend"], ["टेबल बुकिंग"], ["ਟੇਬਲ ਬੁਕਿੰਗ"]]),
    ("hinglish", "Student discount milega kya?", [["Student", "10%"], ["छात्रों", "10%"]]),
    ("hinglish", "Kya aap log Zomato Swiggy pe ho?", [["Zomato"], ["ज़ोमैटो"]]),
    ("hinglish", "Birthday pe kuch free milta hai kya?", [["Birthday", "dessert"], ["जन्मदिन", "डेज़र्ट"]]),
    # --- Punjabi (Gurmukhi) ---
    ("pa", "ਦਾਲ ਮੱਖਣੀ ਦਾ ਰੇਟ ਕੀ ਹੈ?", ["Dal Makhani", "Rs. 280"]),
    ("pa", "ਤੁਸੀਂ ਕਿੰਨੇ ਵਜੇ ਖੁੱਲ੍ਹਦੇ ਹੋ?", [["8:00 AM", "11:30 PM"], ["8:00 ਵਜੇ", "11:30 ਵਜੇ"]]),
    ("pa", "ਸਰ੍ਹੋਂ ਦਾ ਸਾਗ ਮਿਲਦਾ ਹੈ ਕੀ?", ["Sarson da Saag"]),
    ("pa", "ਹੋਮ ਡਿਲੀਵਰੀ ਹੈ ਕੀ?", [["home delivery", "6 km"], ["ਹੋਮ ਡਿਲੀਵਰੀ", "6 ਕਿਲੋਮੀਟਰ"]]),
    ("pa", "ਲੱਸੀ ਕਿੰਨੇ ਦੀ ਹੈ?", ["Sweet Lassi", "Rs. 110"]),
    ("pa", "ਵਿਦਿਆਰਥੀਆਂ ਲਈ ਕੋਈ ਛੋਟ ਹੈ?", [["Student", "10%"], ["ਵਿਦਿਆਰਥੀਆਂ", "10%"]]),
]


def _matches(text: str, must: list) -> bool:
    """must = one list of strings, or a list of alternative lists (any one list matching is enough)."""
    groups = [must] if must and isinstance(must[0], str) else must
    t = text.lower()
    return any(all(m.lower() in t for m in g) for g in groups)


def _hit_rank(results: list[dict], must: list) -> int | None:
    for rank, doc in enumerate(results, start=1):
        if _matches(doc["text"], must):
            return rank
    return None


def check_kb() -> int:
    from text_chunker import chunk_markdown

    chunks = chunk_markdown(Path(KB_FILE).read_text(encoding="utf-8"))
    bad = 0
    for lang, question, must in CASES:
        if not any(_matches(c["text"], must) for c in chunks):
            print(f"[KB MISSING] ({lang}) {question} -> {must}")
            bad += 1
    print(f"{len(CASES) - bad}/{len(CASES)} cases are answerable from the chunked KB.")
    return bad


def main() -> None:
    if "--check-kb" in sys.argv:
        sys.exit(1 if check_kb() else 0)

    k = 5
    if "--k" in sys.argv:
        k = int(sys.argv[sys.argv.index("--k") + 1])

    from rag import search_chunks  # imported here so --check-kb needs no database

    totals = defaultdict(lambda: {"n": 0, "top1": 0, "top3": 0, "topk": 0})
    for lang, question, must in CASES:
        results = search_chunks(question, top_k=k)
        rank = _hit_rank(results, must)

        for key in (lang, "ALL"):
            t = totals[key]
            t["n"] += 1
            if rank == 1:
                t["top1"] += 1
            if rank is not None and rank <= 3:
                t["top3"] += 1
            if rank is not None:
                t["topk"] += 1

        label = f"rank {rank}" if rank else "MISS"
        print(f"[{label:>7}] ({lang}) {question}")
        if rank is None or rank > 1:
            for r in results[:3]:
                body = r["text"].split("\n")[1:2]
                first_line = body[0][:45] if body else ""
                print(f"            {r['score']:.3f}  {r.get('section', '?')}  ::  {first_line}")

    print("\n=== Summary (hit rate) ===")
    print(f"{'lang':<10}{'n':>4}{'top-1':>8}{'top-3':>8}{f'top-{k}':>8}")
    for key in ["en", "hi", "hinglish", "pa", "ALL"]:
        t = totals[key]
        n = t["n"]
        print(f"{key:<10}{n:>4}{t['top1'] / n:>8.0%}{t['top3'] / n:>8.0%}{t['topk'] / n:>8.0%}")


if __name__ == "__main__":
    main()