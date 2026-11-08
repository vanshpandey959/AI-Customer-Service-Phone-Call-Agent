from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from rag import get_answer, reconcile_flagged_moments

app = FastAPI(title="Restaurant CS Agent — RAG Service")


class Message(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class AskRequest(BaseModel):
    message: str
    history: list[Message] = []


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
    result = get_answer(request.message, history)
    return AskResponse(**result)


@app.post("/reconcile", response_model=ReconcileResponse)
def reconcile(request: ReconcileRequest):
    """
    Called once, at call-end, with the moments flagged as complaint/feedback
    during the call. Returns a deduplicated, cleaned-up list of each.
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
