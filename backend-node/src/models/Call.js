import mongoose from "mongoose";

const transcriptEntrySchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    // Set only on "user" entries, by the per-turn RAG classification.
    // Complaint/Feedback documents are NOT created from this directly —
    // they're created once, at call-end, by the reconciliation pass,
    // which reads back whichever entries are tagged here. This field is
    // just a durable marker so that pass knows what to look at.
    classification: {
      type: String,
      enum: ["complaint", "feedback", "normal", null],
      default: null,
    },
    // Set only on "user" entries of phone calls handled by Gnani: the conversation
    // language at that turn ("en-IN", "hi-IN" or "pa-IN"), shown as a badge in the dashboard.
    language: { type: String, default: null },
  },
  { _id: false }
);

const callSchema = new mongoose.Schema({
  // Which entry point created this call — web chat (the frontend
  // simulator) or a real Twilio phone call.
  channel: { type: String, enum: ["web", "phone"], default: "web" },
  // Twilio's own call identifier. Only set for channel: "phone" calls —
  // this is what Twilio's webhooks use to refer to a call, so it's how
  // voice routes look a call back up (web chat calls use the Mongo _id
  // directly instead, via sessionId, since there's no external ID for them).
  callSid: { type: String, default: null, index: true, sparse: true, unique: true },
  // The caller's phone number, as reported by Twilio (the "From" field).
  // Only set for channel: "phone" calls.
  callerNumber: { type: String, default: null },
  transcript: { type: [transcriptEntrySchema], default: [] },
  status: { type: String, enum: ["active", "ended"], default: "active" },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  // Set once the end-of-call reconciliation pass has run, so ending an
  // already-ended call (e.g. a duplicate request) doesn't create
  // duplicate Complaint/Feedback documents.
  reconciledAt: { type: Date, default: null },
});

export default mongoose.model("Call", callSchema);
