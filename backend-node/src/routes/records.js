import { Router } from "express";
import mongoose from "mongoose";
import Call from "../models/Call.js";
import Complaint from "../models/Complaint.js";
import Feedback from "../models/Feedback.js";
import { isValidCallId } from "../callService.js";

const router = Router();

// Express 4 does not catch errors thrown inside async handlers: without this wrapper a
// database hiccup becomes an unhandled promise rejection, which crashes the whole server
// (and any phone call in progress with it). The wrapper passes the error to Express's
// error handler in server.js, which answers 500 and keeps running.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** List all calls (summary only — no full transcript, keeps the list light). */
router.get("/calls", wrap(async (req, res) => {
  const calls = await Call.find({}, "channel callSid callerNumber status startedAt endedAt transcript")
    .sort({ startedAt: -1 })
    .lean();

  res.json(
    calls.map((c) => ({
      id: c._id,
      channel: c.channel,
      callSid: c.callSid,
      callerNumber: c.callerNumber,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      messageCount: c.transcript.length,
    }))
  );
}));

/** Full detail for one call, including its linked complaints and feedback. */
router.get("/calls/:id", wrap(async (req, res) => {
  const { id } = req.params;
  if (!isValidCallId(id)) {
    return res.status(400).json({ error: "Invalid call id" });
  }

  const call = await Call.findById(id).lean();
  if (!call) {
    return res.status(404).json({ error: "Call not found" });
  }

  const [complaints, feedback] = await Promise.all([
    Complaint.find({ callId: id }).lean(),
    Feedback.find({ callId: id }).lean(),
  ]);

  res.json({ ...call, complaints, feedback });
}));

/** Delete a call, cascading to delete its linked complaints and feedback too. */
router.delete("/calls/:id", wrap(async (req, res) => {
  const { id } = req.params;
  if (!isValidCallId(id)) {
    return res.status(400).json({ error: "Invalid call id" });
  }

  const call = await Call.findById(id);
  if (!call) {
    return res.status(404).json({ error: "Call not found" });
  }

  await Promise.all([
    Complaint.deleteMany({ callId: id }),
    Feedback.deleteMany({ callId: id }),
    Call.deleteOne({ _id: id }),
  ]);

  res.json({ deleted: true });
}));

/** All complaints, most recent first. */
router.get("/complaints", wrap(async (req, res) => {
  const complaints = await Complaint.find({}).sort({ createdAt: -1 }).lean();
  res.json(complaints);
}));

/** Update a complaint's status (pending <-> resolved). */
router.patch("/complaints/:id", wrap(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid complaint id" });
  }
  if (!["pending", "resolved"].includes(status)) {
    return res.status(400).json({ error: "status must be 'pending' or 'resolved'" });
  }

  const complaint = await Complaint.findByIdAndUpdate(id, { status }, { new: true });
  if (!complaint) {
    return res.status(404).json({ error: "Complaint not found" });
  }

  res.json(complaint);
}));

/** Delete a single complaint. */
router.delete("/complaints/:id", wrap(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid complaint id" });
  }

  const result = await Complaint.findByIdAndDelete(id);
  if (!result) {
    return res.status(404).json({ error: "Complaint not found" });
  }

  res.json({ deleted: true });
}));

/** All feedback, most recent first. */
router.get("/feedback", wrap(async (req, res) => {
  const feedback = await Feedback.find({}).sort({ createdAt: -1 }).lean();
  res.json(feedback);
}));

/** Delete a single feedback entry. */
router.delete("/feedback/:id", wrap(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid feedback id" });
  }

  const result = await Feedback.findByIdAndDelete(id);
  if (!result) {
    return res.status(404).json({ error: "Feedback not found" });
  }

  res.json({ deleted: true });
}));

export default router;
