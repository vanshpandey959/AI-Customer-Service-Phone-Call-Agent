import { config } from "./config.js";

async function post(path, body) {
  const response = await fetch(`${config.pythonServiceUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `RAG service (${path}) responded with ${response.status}: ${errorBody || response.statusText}`
    );
  }

  return response.json();
}

/**
 * Calls the Python RAG service's /ask endpoint.
 * Python is stateless — it takes the current message plus history and
 * returns an answer plus a classification ("complaint" | "feedback" |
 * "normal"). Node persists the classification as a tag on the transcript
 * entry — it does NOT create a Complaint/Feedback document from this
 * directly; that only happens via the end-of-call reconciliation pass.
 */
export async function askRagService(message, history, language) {
  const body = { message, history };
  // Optional conversation language ("hi-IN", "pa-IN", "en-IN"): only a tie-breaker
  // for very short replies, see backend-python/rag.py.
  if (language) body.language = language;
  const data = await post("/ask", body);
  return { answer: data.answer, classification: data.classification };
}

/**
 * Calls the Python RAG service's /reconcile endpoint, once, at call-end.
 * `flaggedMoments` is a list of {content, classification, context} for
 * every transcript entry tagged complaint/feedback during the call.
 * Returns deduplicated, cleaned-up lists: {complaints: string[], feedback: string[]}.
 */
export async function reconcileFlaggedMoments(flaggedMoments) {
  const data = await post("/reconcile", { flagged: flaggedMoments });
  return { complaints: data.complaints, feedback: data.feedback };
}