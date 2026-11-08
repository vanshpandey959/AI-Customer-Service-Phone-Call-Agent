"""
Where does the time go in one /ask turn?

For three questions (English, Hindi, Punjabi) it measures, separately:
  retrieval  - embedding the question + the Atlas vector search
  groq wall  - the whole Groq call
  queue      - time Groq made the request wait before starting (busy/free tier)
  prompt     - time Groq spent reading the prompt
  generate   - time Groq spent writing the reply
  tokens     - tokens in / out, and hidden reasoning tokens if reported
It also turns off the SDK's automatic retries, so a rate-limit error (429) shows up
as an error instead of silently adding seconds.

Usage:
    python latency_probe.py                      # model from your .env (GROQ_MODEL)
    python latency_probe.py --models openai/gpt-oss-120b,openai/gpt-oss-20b
Costs 3 Groq calls per model.
"""

import sys
import time

QUESTIONS = [
    ("en", "What time do you close on Friday?", None, "en-IN"),
    ("hi", "दाल मखनी कितने रुपये की है?", None, "hi-IN"),
    ("pa", "ਦਾਲ ਮੱਖਣੀ ਦਾ ਰੇਟ ਕੀ ਹੈ?", None, "pa-IN"),
]


def _usage_dict(completion) -> dict:
    usage = getattr(completion, "usage", None)
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        return usage.model_dump()
    return dict(usage) if isinstance(usage, dict) else {}


def _fmt(value, digits=2):
    return "-" if value is None else (f"{value:.{digits}f}s" if isinstance(value, float) else str(value))


def main() -> None:
    from groq import Groq

    from config import GROQ_API_KEY, GROQ_MODEL
    from rag import _reasoning_kwargs, build_messages, build_search_query, retrieve_context

    args = sys.argv[1:]
    models = [GROQ_MODEL]
    if "--models" in args:
        models = [m.strip() for m in args[args.index("--models") + 1].split(",") if m.strip()]

    client = Groq(api_key=GROQ_API_KEY, max_retries=0)

    print("Warming up the embedding model (not counted)...")
    retrieve_context("warm up")

    for model in models:
        print(f"\n=== {model} ===")
        for tag, question, history, language in QUESTIONS:
            start = time.time()
            chunks = retrieve_context(build_search_query(question, history))
            retrieval = time.time() - start

            messages = build_messages(question, chunks, history, language)
            kwargs = dict(
                model=model,
                messages=messages,
                temperature=0.3,
                response_format={"type": "json_object"},
                **_reasoning_kwargs(model),
            )
            start = time.time()
            try:
                raw = client.chat.completions.with_raw_response.create(**kwargs)
                completion, headers = raw.parse(), raw.headers
            except AttributeError:  # SDK without raw responses
                completion, headers = client.chat.completions.create(**kwargs), {}
            except Exception as exc:
                print(f"{tag}: ERROR after {time.time() - start:.1f}s: {str(exc).splitlines()[0][:200]}")
                continue
            wall = time.time() - start

            usage = _usage_dict(completion)
            details = usage.get("completion_tokens_details") or {}
            reasoning = details.get("reasoning_tokens") if isinstance(details, dict) else None
            print(
                f"{tag}: retrieval {retrieval * 1000:.0f} ms | groq wall {wall:.1f}s | "
                f"queue {_fmt(usage.get('queue_time'))} | prompt {_fmt(usage.get('prompt_time'))} | "
                f"generate {_fmt(usage.get('completion_time'))} | "
                f"tokens in/out {usage.get('prompt_tokens')}/{usage.get('completion_tokens')} "
                f"(reasoning {reasoning})"
            )
            left = headers.get("x-ratelimit-remaining-tokens") if headers else None
            if left is not None:
                print(f"      tokens left in this minute's window: {left}")
            time.sleep(1.5)


if __name__ == "__main__":
    main()