import mongoose from "mongoose";

const complaintSchema = new mongoose.Schema({
  callId: { type: mongoose.Schema.Types.ObjectId, ref: "Call", required: true },
  message: { type: String, required: true }, // the customer's original wording
  status: { type: String, enum: ["pending", "resolved"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Complaint", complaintSchema);
