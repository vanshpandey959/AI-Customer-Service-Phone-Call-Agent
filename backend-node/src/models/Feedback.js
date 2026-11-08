import mongoose from "mongoose";

const feedbackSchema = new mongoose.Schema({
  callId: { type: mongoose.Schema.Types.ObjectId, ref: "Call", required: true },
  message: { type: String, required: true }, // the customer's original wording
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Feedback", feedbackSchema);
