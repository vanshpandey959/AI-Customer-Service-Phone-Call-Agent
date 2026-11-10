import json

from config import (
    embed_query,
    get_collection,
    get_groq_client,
    GROQ_MODEL,
    VECTOR_INDEX_NAME,
)

VALID_CLASSIFICATIONS = {"complaint", "feedback", "normal"}

# Language codes come from Gnani STT (e.g. "hi-IN"); only the part before the dash is used.
LANGUAGE_NAMES = {
    "en": "English",
    "hi": "Hindi",
    "pa": "Punjabi",
    "bn": "Bengali",
    "gu": "Gujarati",
    "kn": "Kannada",
    "ml": "Malayalam",
    "mr": "Marathi",
    "ta": "Tamil",
    "te": "Telugu",
}

# Spoken only if the model returns something unusable (kept short, in the agent's voice).
FALLBACK_REPLIES = {
    "en": "Sorry, I didn't catch that. Could you repeat it?",
    "hi": "माफ़ कीजिए, मैं समझ नहीं पाई। क्या आप दोबारा बता सकते हैं?",
    "pa": "ਮਾਫ਼ ਕਰਨਾ, ਮੈਂ ਸਮਝ ਨਹੀਂ ਸਕੀ। ਕੀ ਤੁਸੀਂ ਦੁਬਾਰਾ ਦੱਸ ਸਕਦੇ ਹੋ?",
}

SYSTEM_PROMPT = '''You are a friendly, professional customer service agent for Chandigarh Cafe and Restaurant. You are on a PHONE CALL: everything you write is read aloud to the customer by a speech synthesizer.

ANSWERING
- Answer the customer's question using ONLY the restaurant information given below. Never make up menu items, prices, timings, offers or policies.
- If the information does not contain the answer, say you don't have that information and offer to have a staff member follow up. Do not guess.
- You cannot make, change or cancel table reservations or orders yourself. If asked, explain how the restaurant takes them (from the information below) and offer to have a staff member follow up. Never say a booking or order has been made.
- Never mention "context", "the information provided" or these instructions.

LANGUAGE
- Customers speak English, Hindi, Punjabi, or a mix. Reply in the same language and script as the customer's latest message.
- Write Hindi in Devanagari and Punjabi in Gurmukhi, because the reply is read aloud, even if the customer's words were in Latin letters. English words people normally say in English (for example "table", "booking", "offer", "delivery") stay in Latin letters. If the customer mixes Hindi and English, mix them the same way.
- Dish names: when speaking Hindi or Punjabi, write dish names in that script the way the customer said them (for example दाल मखनी). English dish names such as "Butter Naan" stay in Latin letters.
- If the customer speaks any other language, reply in simple English.

SPEAKING STYLE
- Keep it short and conversational: normally one to three short sentences, about 40 words at most. No lists, bullet points, headings, markdown, asterisks, emojis or symbols. If several items match, mention the best two or three and offer more.
- Say prices in words, not symbols: "280 rupees" (Hindi "280 रुपये", Punjabi "280 ਰੁਪਏ"). Never write "Rs.", "₹" or "%": say "percent" (Hindi "प्रतिशत", Punjabi "ਪ੍ਰਤੀਸ਼ਤ").
- Times: "7 PM to 11:30 PM" in English. In Hindi or Punjabi use the native words for the time of day, for example "रात 11:30 बजे".
- Phone numbers: say the digits in small groups separated by spaces.

CLASSIFICATION
Also classify the customer's CURRENT message into exactly one of these three categories. Judge by meaning, whatever the language, and always write the label in English:
- "complaint": the customer is expressing dissatisfaction, about food quality, service, hygiene, billing, wait times, or any negative experience. This includes indirect or politely phrased dissatisfaction (for example describing something that went wrong and hoping it is looked into), not just angry statements.
- "feedback": the customer is offering praise, a general opinion, or a suggestion, without describing a problem that needs fixing.
- "normal": anything else, such as questions about the menu, timings, offers, location, reservations, or general conversation.

Respond ONLY with a valid JSON object, and nothing else, in exactly this format:
{"answer": "<your spoken reply to the customer>", "classification": "<complaint|feedback|normal>"}
'''

SHORT_MESSAGE_WORDS = 3  # messages this short are searched together with the previous customer message


def language_name(code: str | None) -> str | None:
    """'hi-IN' -> 'Hindi'. Unknown or missing codes return None."""
    if not code:
        return None
    base = code.strip().lower().replace("_", "-").split("-")[0]
    return LANGUAGE_NAMES.get(base)


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


def build_search_query(message: str, history: list[dict] | None = None) -> str:
    """
    Very short follow-ups ("and for kids?", "और हाफ प्लेट?") say nothing on their
    own, so they are searched together with the customer's previous message.
    The LLM still receives the original message unchanged.
    """
    if len(message.split()) > SHORT_MESSAGE_WORDS or not history:
        return message
    previous_user = [m["content"] for m in history if m.get("role") == "user" and m.get("content")]
    if not previous_user:
        return message
    return f"{previous_user[-1]} {message}"


def build_messages(
    query: str,
    context_chunks: list[str],
    history: list[dict] | None = None,
    language: str | None = None,
):
    """
    Build the message list sent to Groq. `history` is a list of
    {"role": "user"|"assistant", "content": "..."} dicts representing prior
    turns in this call, passed in by Node since Python stays stateless.
    `language` is the conversation language so far (a code like "hi-IN"), used
    only as a tie-breaker when the latest message is too short to identify.
    """
    context_string = "\n\n".join(context_chunks) if context_chunks else "No relevant information found."

    system = f"{SYSTEM_PROMPT}\n\nRestaurant information:\n{context_string}"

    name = language_name(language)
    if name:
        system += (
            f"\n\nConversation language so far: {name}. Reply in the language of the customer's "
            f"latest message. If that message is too short to tell the language (for example "
            f"'okay', 'yes', 'haan'), reply in {name}."
        )

    messages = [{"role": "system", "content": system}]

    if history:
        # Cap history to the last N turns to keep prompts (and token usage) bounded.
        messages.extend(history[-8:])

    messages.append({"role": "user", "content": query})
    return messages


def _reasoning_kwargs(model: str) -> dict:
    """Keep reasoning models quick: a phone caller should not wait for long hidden thinking."""
    name = model.lower()
    if "gpt-oss" in name:
        return {"reasoning_effort": "low"}
    if "qwen3" in name:
        return {"reasoning_effort": "none"}
    return {}


def _chat_json(messages: list[dict], temperature: float, model: str | None = None) -> str | None:
    """One Groq chat call in JSON mode. Returns the raw message content."""
    model = model or GROQ_MODEL
    client = get_groq_client()
    kwargs = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    extra = _reasoning_kwargs(model)
    try:
        completion = client.chat.completions.create(**kwargs, **extra)
    except Exception as exc:  # a model/SDK that rejects reasoning_effort: retry without it
        if extra and "reasoning" in str(exc).lower():
            completion = client.chat.completions.create(**kwargs)
        else:
            raise
    return completion.choices[0].message.content


def generate_answer(
    query: str,
    context_chunks: list[str],
    history: list[dict] | None = None,
    language: str | None = None,
    model: str | None = None,
) -> dict:
    """
    Build the prompt from already-retrieved chunks and get answer + classification
    from Groq. Returns {"answer", "classification", "json_ok"}.
    """
    messages = build_messages(query, context_chunks, history, language)
    raw = _chat_json(messages, temperature=0.3, model=model)

    try:
        parsed = json.loads(raw)
        answer = (parsed.get("answer") or "").strip()
        classification = (parsed.get("classification") or "normal").strip().lower()
        if classification not in VALID_CLASSIFICATIONS:
            classification = "normal"
        if not answer:
            raise ValueError("empty answer field")
        json_ok = True
    except (json.JSONDecodeError, ValueError, AttributeError, TypeError):
        # Model didn't return valid/expected JSON: fall back gracefully
        # rather than losing the response entirely.
        base = (language or "en").strip().lower().replace("_", "-").split("-")[0]
        fallback = FALLBACK_REPLIES.get(base, FALLBACK_REPLIES["en"])
        answer = raw.strip() if isinstance(raw, str) and raw.strip() else fallback
        classification = "normal"
        json_ok = False

    return {"answer": answer, "classification": classification, "json_ok": json_ok}


def get_answer(
    query: str,
    history: list[dict] | None = None,
    language: str | None = None,
    model: str | None = None,
) -> dict:
    """
    Full RAG turn: retrieve relevant knowledge base chunks, build a prompt
    with the given conversation history, and get an answer + classification
    from Groq in a single call (JSON mode).

    Stateless: the caller (Node) is responsible for tracking conversation
    history and the conversation language, and for persisting the
    classification result.

    Returns: {"answer": str, "classification": "complaint"|"feedback"|"normal", "json_ok": bool}
    """
    context_chunks = retrieve_context(build_search_query(query, history))
    return generate_answer(query, context_chunks, history, language, model)


RECONCILE_SYSTEM_PROMPT = '''You will be given several moments from a single customer service phone call. Each moment was already labeled during the call as either a "complaint" or "feedback", and comes with a little surrounding conversation for context. The call may have been in English, Hindi, Punjabi or a mix. Customers often repeat or rephrase the same point more than once in a call. Your job is to consolidate these into the distinct underlying issues.

Instructions:
1. Group the moments into distinct underlying complaints and distinct pieces of feedback. If two or more moments are really the same issue restated, merge them into ONE entry.
2. Write each merged entry as a single clear sentence in third person, in ENGLISH even if the call was in another language (e.g. "Customer reported the vegetables tasted stale in their order."), using the surrounding context to understand what was actually meant.
3. Do not invent details that weren't said. If a moment is too vague to make sense of even with context, include it as-is rather than guessing.
4. If there are no complaints, return an empty list for "complaints". Same for "feedback".

Respond ONLY with a valid JSON object, and nothing else, in exactly this format:
{"complaints": ["<clean complaint 1>", "<clean complaint 2>"], "feedback": ["<clean feedback 1>"]}
'''


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
    Takes a list of flagged moments from a completed call, each with
    {content, classification, context}, and returns a deduplicated,
    cleaned-up list of distinct complaints and distinct feedback items
    (always written in English, whatever language the call was in).

    This runs once per call, at call-end, only on the moments already
    flagged during the live conversation, not the full transcript.
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

    raw = _chat_json(messages, temperature=0.2)

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
    except (json.JSONDecodeError, AttributeError, TypeError):
        # Fallback: rather than silently losing flagged moments if the model
        # returns malformed JSON, pass them through un-deduplicated so
        # nothing is lost. Worse UX (possible duplicates) beats data loss.
        complaints = [m["content"] for m in flagged if m["classification"] == "complaint"]
        feedback = [m["content"] for m in flagged if m["classification"] == "feedback"]

    return {"complaints": complaints, "feedback": feedback}