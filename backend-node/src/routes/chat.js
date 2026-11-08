import { Router } from "express";
import {
  createCall,
  isValidCallId,
  getCall,
  getHistoryForRag,
  appendTurn,
  markCallEnded,
  reconcileCall,
} from "../callService.js";
import { askRagService } from "../ragClient.js";

const router = Router();

/** Start a new call. */
router.post("/start", async (req, res) => {
  try {
    const sessionId = await createCall();
    res.json({ sessionId });
  } catch (err) {
    console.error("Error creating call:", err.message);
    res.status(500).json({ error: "Could not start a new call." });
  }
});

/** Send a message in an existing call, get the agent's reply. */
router.post("/message", async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !isValidCallId(sessionId)) {
    return res.status(404).json({ error: "Unknown sessionId. Start a new session." });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const call = await getCall(sessionId);
    if (!call) {
      return res.status(404).json({ error: "Unknown sessionId. Start a new session." });
    }
    if (call.status === "ended") {
      return res.status(400).json({ error: "This call has ended. Start a new session." });
    }

    const historyBeforeThisTurn = await getHistoryForRag(sessionId);
    const trimmedMessage = message.trim();
    const { answer, classification } = await askRagService(trimmedMessage, historyBeforeThisTurn);
    // Tags the transcript entry with its classification — does NOT create
    // a Complaint/Feedback document yet. That happens once, at call-end,
    // via the reconciliation pass (see /end below), so repeated
    // restatements of the same issue get merged into one clean record.
    await appendTurn(sessionId, trimmedMessage, answer, classification);

    res.json({ answer, classification });
  } catch (err) {
    console.error("Error handling message:", err.message);
    res.status(502).json({
      error: "The agent couldn't be reached right now. Please try again in a moment.",
    });
  }
});

/**
 * End a call. Runs the end-of-call reconciliation pass exactly once —
 * idempotent, so a duplicate /end request (e.g. a retried network call)
 * won't create duplicate Complaint/Feedback documents.
 */
router.post("/end", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !isValidCallId(sessionId)) {
    return res.status(400).json({ error: "A valid sessionId is required" });
  }

  const call = await getCall(sessionId);
  if (!call) {
    return res.status(404).json({ error: "Unknown sessionId." });
  }

  if (call.reconciledAt) {
    // Already ended and reconciled — respond success without redoing work.
    return res.json({ ended: true, alreadyEnded: true });
  }

  try {
    if (call.status !== "ended") {
      await markCallEnded(sessionId);
    }
    const { complaints, feedback } = await reconcileCall(sessionId);
    res.json({ ended: true, complaintsFound: complaints.length, feedbackFound: feedback.length });
  } catch (err) {
    console.error("Error ending/reconciling call:", err.message);
    // The call is still marked ended even if reconciliation failed — the
    // tagged transcript entries remain safely in MongoDB either way, so
    // this can be retried or swept up later without data loss.
    res.status(502).json({
      error: "Call ended, but the agent couldn't process complaints/feedback right now.",
    });
  }
});

export default router;
