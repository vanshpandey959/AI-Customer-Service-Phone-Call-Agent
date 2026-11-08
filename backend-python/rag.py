import json

from config import (
    embed_query,
    get_collection,
    get_groq_client,
    GROQ_MODEL,
    VECTOR_INDEX_NAME,
)

VALID_CLASSIFICATIONS = {"complaint", "feedback", "normal"}

SYSTEM_PROMPT = """You are a friendly, professional customer service agent for \
Chandigarh Cafe and Restaurant, a restaurant. Answer the customer's question using ONLY \
the context provided below. Keep answers short and conversational, like a \
real phone agent would speak — not a bulleted list, unless the customer \
specifically asks for a list.

If the context doesn't contain the answer, say you don't have that \
information and offer to have a human staff member follow up. Never make up \
menu items, prices, or policies that aren't in the context.

You must also classify the customer's CURRENT message into exactly one of \
these three categories:
- "complaint": the customer is expressing dissatisfaction — about food \
quality, service, hygiene, billing, wait times, or any negative experience. \
This includes indirect or politely-phrased dissatisfaction (e.g. describing \
something that went wrong and hoping it's looked into), not just angry \
statements.
- "feedback": the customer is offering praise, a general opinion, or a \
suggestion, without describing a problem that needs fixing.
- "normal": anything else — questions about the menu, timings, offers, \
location, reservations, or general conversation.

Respond ONLY with a valid JSON object, and nothing else, in exactly this \
format:
{"answer": "<your spoken reply to the customer>", "classification": "<complaint|feedback|normal>"}
"""


def search_chunks(query: str, top_k: int = 5) -> list[dict]:
    """
    Embed the query and run a MongoDB Atlas vector search.
    Returns [{"text", "section", "score"}, ...], best match first.
    """
    collection = get_collection()
    pipeline = [
        {
            "$vectorSearch": {
                "index": VECTOR_INDEX_NAME,
                "path": "embedding",
                "queryVector": embed_query(query),
                "numCandidates": 100,
                "limit": top_k,
            }
        },
        {
            "$project": {
                "_id": 0,
                "text": 1,
                "section": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]
    return list(collection.aggregate(pipeline))


def retrieve_context(query: str, top_k: int = 5) -> list[str]:
    """Text of the top-k chunks most relevant to the query."""
    return [doc["text"] for doc in search_chunks(query, top_k)]


def build_messages(query: str, context_chunks: list[str], history: list[dict] | None = None):
    """
    Build the message list sent to Groq. `history` is a list of
    {"role": "user"|"assistant", "content": "..."} dicts representing prior
    turns in this call — passed in by Node, since Python stays stateless.
    """
    context_string = "\n\n".join(context_chunks) if context_chunks else "No relevant information found."

    messages = [{"role": "system", "content": f"{SYSTEM_PROMPT}\n\nContext:\n{context_string}"}]

    if history:
        # Cap history to the last N turns to keep prompts (and token usage) bounded.
        messages.extend(history[-8:])

    messages.append({"role": "user", "content": query})
    return messages


def get_answer(query: str, history: list[dict] | None = None) -> dict:
    """
    Full RAG turn: retrieve relevant knowledge base chunks, build a prompt
    with the given conversation history, and get an answer + classification
    from Groq in a single call (JSON mode).

    Stateless — caller (Node) is responsible for tracking conversation
    history and for persisting the classification result (e.g. as a
    Complaint or Feedback record).

    Returns: {"answer": str, "classification": "complaint"|"feedback"|"normal"}
    """
    context_chunks = retrieve_context(query)
    messages = build_messages(query, context_chunks, history)

    client = get_groq_client()
    completion = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=messages,
        temperature=0.3,
        response_format={"type": "json_object"},
    )

    raw = completion.choices[0].message.content

    try:
        parsed = json.loads(raw)
        answer = (parsed.get("answer") or "").strip()
        classification = (parsed.get("classification") or "normal").strip().lower()
        if classification not in VALID_CLASSIFICATIONS:
            classification = "normal"
        if not answer:
            raise ValueError("empty answer field")
    except (json.JSONDecodeError, ValueError, AttributeError):
        # Model didn't return valid/expected JSON — fall back gracefully
        # rather than losing the response entirely.
        answer = raw.strip() if isinstance(raw, str) else "Sorry, I didn't catch that. Could you repeat it?"
        classification = "normal"

    return {"answer": answer, "classification": classification}


RECONCILE_SYSTEM_PROMPT = """You will be given several moments from a single \
customer service phone call. Each moment was already labeled during the call \
as either a "complaint" or "feedback", and comes with a little surrounding \
conversation for context. Customers often repeat or rephrase the same point \
more than once in a call — your job is to consolidate these into the \
distinct underlying issues.

Instructions:
1. Group the moments into distinct underlying complaints and distinct pieces \
of feedback. If two or more moments are really the same issue restated, \
merge them into ONE entry.
2. Write each merged entry as a single clear sentence in third person (e.g. \
"Customer reported the vegetables tasted stale in their order."), using the \
surrounding context to understand what was actually meant.
3. Do not invent details that weren't said. If a moment is too vague to \
make sense of even with context, include it as-is rather than guessing.
4. If there are no complaints, return an empty list for "complaints". Same \
for "feedback".

Respond ONLY with a valid JSON object, and nothing else, in exactly this \
format:
{"complaints": ["<clean complaint 1>", "<clean complaint 2>"], "feedback": ["<clean feedback 1>"]}
"""


def _format_flagged_moment(moment: dict, index: int) -> str:
    """Render one flagged moment (plus its surrounding context) as text for the prompt."""
    lines = [f"--- Moment {index + 1} (labeled: {moment['classification']}) ---"]

    context = moment.get("context") or []
    if context:
        lines.append("Surrounding conversation:")
        for turn in context:
            lines.append(f"  {turn['role']}: {turn['content']}")

    lines.append(f"Flagged line: \"{moment['content']}\"")
    return "\n".join(lines)


def reconcile_flagged_moments(flagged: list[dict]) -> dict:
    """
    Takes a list of flagged moments from a completed call — each with
    {content, classification, context} — and returns a deduplicated,
    cleaned-up list of distinct complaints and distinct feedback items.

    This runs once per call, at call-end, only on the moments already
    flagged during the live conversation — not the full transcript.
    Stateless, same as get_answer.

    Returns: {"complaints": list[str], "feedback": list[str]}
    """
    if not flagged:
        return {"complaints": [], "feedback": []}

    moments_text = "\n\n".join(
        _format_flagged_moment(m, i) for i, m in enumerate(flagged)
    )

    messages = [
        {"role": "system", "content": RECONCILE_SYSTEM_PROMPT},
        {"role": "user", "content": moments_text},
    ]

    client = get_groq_client()
    completion = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=messages,
        temperature=0.2,
        response_format={"type": "json_object"},
    )

    raw = completion.choices[0].message.content

    try:
        parsed = json.loads(raw)
        complaints = parsed.get("complaints") or []
        feedback = parsed.get("feedback") or []
        if not isinstance(complaints, list):
            complaints = []
        if not isinstance(feedback, list):
            feedback = []
        # Keep only non-empty strings, in case the model includes stray items.
        complaints = [c.strip() for c in complaints if isinstance(c, str) and c.strip()]
        feedback = [f.strip() for f in feedback if isinstance(f, str) and f.strip()]
    except (json.JSONDecodeError, AttributeError):
        # Fallback: rather than silently losing flagged moments if the model
        # returns malformed JSON, pass them through un-deduplicated so
        # nothing is lost — worse UX (possible duplicates) beats data loss.
        complaints = [m["content"] for m in flagged if m["classification"] == "complaint"]
        feedback = [m["content"] for m in flagged if m["classification"] == "feedback"]

    return {"complaints": complaints, "feedback": feedback}