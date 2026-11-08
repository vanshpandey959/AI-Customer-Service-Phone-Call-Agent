import mongoose from "mongoose";
import Call from "./models/Call.js";
import Complaint from "./models/Complaint.js";
import Feedback from "./models/Feedback.js";
import { reconcileFlaggedMoments } from "./ragClient.js";

const HISTORY_TURNS_FOR_RAG = 8; // how many prior turns to send to Python per request
const CONTEXT_WINDOW = 2; // how many surrounding transcript entries to include per flagged moment

export function isValidCallId(callId) {
  return mongoose.Types.ObjectId.isValid(callId);
}

/**
 * Start a new call. Returns the new call's id (its Mongo _id, as a string).
 * Defaults to a web-chat call; pass channel/callSid/callerNumber for a
 * Twilio phone call (see findOrCreateCallByCallSid below, which is what
 * voice routes actually use — this is exported mainly for the web /start route).
 */
export async function createCall({ channel, callSid, callerNumber } = {}) {
  const call = await Call.create({ channel, callSid, callerNumber });
  return call._id.toString();
}

export async function getCall(callId) {
  if (!isValidCallId(callId)) return null;
  return Call.findById(callId);
}

/** Looks up a phone call by Twilio's CallSid (not a Mongo _id). */
export async function getCallByCallSid(callSid) {
  return Call.findOne({ callSid });
}

/**
 * Finds the Call document for an incoming Twilio call by CallSid, creating
 * one if this is the first webhook for that call (i.e. "A call comes in").
 * Idempotent — safe to call again for the same CallSid without creating a
 * duplicate, since Twilio's CallSid is unique per call and the schema
 * enforces that uniqueness too.
 */
export async function findOrCreateCallByCallSid(callSid, callerNumber) {
  const existing = await getCallByCallSid(callSid);
  if (existing) return existing;

  return Call.create({ channel: "phone", callSid, callerNumber });
}

/**
 * Returns the call's transcript so far, trimmed to the last N turns and
 * reshaped to {role, content} — the format the Python RAG service expects
 * for /ask. (Classification tags aren't relevant to answer generation, so
 * they're stripped here.)
 */
export async function getHistoryForRag(callId) {
  const call = await getCall(callId);
  if (!call) return null;

  return call.transcript
    .slice(-HISTORY_TURNS_FOR_RAG * 2)
    .map(({ role, content }) => ({ role, content }));
}

/**
 * Appends a user message + assistant reply to the call's transcript,
 * tagging the user message with its classification. This does NOT create
 * a Complaint/Feedback document — that only happens once, at call-end,
 * via reconcileCall() below, so restatements of the same issue across the
 * call can be merged into one clean record instead of creating a
 * duplicate per turn.
 */
export async function appendTurn(callId, userMessage, assistantMessage, classification) {
  const call = await getCall(callId);
  if (!call) return null;

  call.transcript.push({ role: "user", content: userMessage, classification });
  call.transcript.push({ role: "assistant", content: assistantMessage });
  await call.save();

  return call.transcript;
}

/**
 * Marks the call as ended. Does NOT run reconciliation — call
 * reconcileCall() separately so the caller can decide idempotency
 * (e.g. skip reconciliation if the call was already ended).
 */
export async function markCallEnded(callId) {
  const call = await getCall(callId);
  if (!call) return null;

  call.status = "ended";
  call.endedAt = new Date();
  await call.save();
  return call;
}

/**
 * Builds a short window of surrounding transcript entries for a flagged
 * moment at `index`, so the reconciliation pass isn't reading isolated
 * lines out of context.
 */
function buildContextWindow(transcript, index) {
  const start = Math.max(0, index - CONTEXT_WINDOW);
  const end = Math.min(transcript.length, index + CONTEXT_WINDOW + 1);
  return transcript
    .slice(start, end)
    .filter((_, i) => start + i !== index) // exclude the flagged line itself
    .map(({ role, content }) => ({ role, content }));
}

/**
 * Runs the end-of-call reconciliation pass: finds every transcript entry
 * tagged complaint/feedback, sends them (with surrounding context) to the
 * Python service for deduplication, and creates the final Complaint/
 * Feedback documents from the result.
 *
 * Safe to call on a call with no flagged moments — skips the Groq call
 * entirely in that case. Guards against double-reconciliation via
 * `reconciledAt` — call this only once you've confirmed the call wasn't
 * already reconciled (see the /end route for that check).
 */
export async function reconcileCall(callId) {
  const call = await getCall(callId);
  if (!call) return null;

  const flaggedMoments = call.transcript
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.classification === "complaint" || entry.classification === "feedback")
    .map(({ entry, index }) => ({
      content: entry.content,
      classification: entry.classification,
      context: buildContextWindow(call.transcript, index),
    }));

  let result = { complaints: [], feedback: [] };

  if (flaggedMoments.length > 0) {
    result = await reconcileFlaggedMoments(flaggedMoments);

    await Promise.all([
      ...result.complaints.map((message) => Complaint.create({ callId: call._id, message })),
      ...result.feedback.map((message) => Feedback.create({ callId: call._id, message })),
    ]);
  }

  call.reconciledAt = new Date();
  await call.save();

  return result;
}
