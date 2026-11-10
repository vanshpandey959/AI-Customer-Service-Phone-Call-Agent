from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from rag import get_answer, reconcile_flagged_moments, retrieve_context


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Do the slow one-time work now instead of during the first phone call: loading the
    # embedding model (several seconds) and opening the MongoDB connection.
    try:
        retrieve_context("warm up")
        print("RAG warm-up done: embedding model loaded, MongoDB connected.")
    except Exception as exc:  # never block startup; the first request will just be slower
        print(f"RAG warm-up failed ({exc}); the first request will be slow.")
    yield


app = FastAPI(title="Restaurant CS Agent — RAG Service", lifespan=lifespan)


class Message(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class AskRequest(BaseModel):
    message: str
    history: list[Message] = []
    # Conversation language so far, as a code such as "hi-IN" / "pa-IN" / "en-IN"
    # (the detected_language_code from Gnani STT). Optional: used only as a
    # tie-breaker when the latest message is too short to tell the language.
    language: str | None = None


class AskResponse(BaseModel):
    answer: str
    classification: str  # "complaint" | "feedback" | "normal"


class FlaggedMoment(BaseModel):
    content: str
    classification: str  # "complaint" | "feedback"
    context: list[Message] = []  # a few surrounding transcript lines, for context


class ReconcileRequest(BaseModel):
    flagged: list[FlaggedMoment]


class ReconcileResponse(BaseModel):
    complaints: list[str]
    feedback: list[str]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ask", response_model=AskResponse)
def ask(request: AskRequest):
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="message cannot be empty")

    history = [{"role": m.role, "content": m.content} for m in request.history]
    result = get_answer(request.message, history, language=request.language)
    return AskResponse(answer=result["answer"], classification=result["classification"])


@app.post("/reconcile", response_model=ReconcileResponse)
def reconcile(request: ReconcileRequest):
    """
    Called once, at call-end, with the moments flagged as complaint/feedback
    during the call. Returns a deduplicated, cleaned-up list of each
    (always written in English, whatever language the call was in).
    """
    flagged = [
        {
            "content": m.content,
            "classification": m.classification,
            "context": [{"role": c.role, "content": c.content} for c in m.context],
        }
        for m in request.flagged
    ]
    result = reconcile_flagged_moments(flagged)
    return ReconcileResponse(**result)