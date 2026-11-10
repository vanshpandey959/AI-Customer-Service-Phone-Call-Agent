const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function request(path, options) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with status ${response.status}`);
  }
  return response.json();
}

export function fetchCalls() {
  return request("/api/calls");
}

export function fetchCallDetail(callId) {
  return request(`/api/calls/${callId}`);
}

export function deleteCall(callId) {
  return request(`/api/calls/${callId}`, { method: "DELETE" });
}

export function fetchComplaints() {
  return request("/api/complaints");
}

export function updateComplaintStatus(complaintId, status) {
  return request(`/api/complaints/${complaintId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function deleteComplaint(complaintId) {
  return request(`/api/complaints/${complaintId}`, { method: "DELETE" });
}

export function fetchFeedback() {
  return request("/api/feedback");
}

export function deleteFeedback(feedbackId) {
  return request(`/api/feedback/${feedbackId}`, { method: "DELETE" });
}

/**
 * Triggers an outbound call from your Twilio number to your own real
 * phone (see backend-node's .env — TEST_PHONE_NUMBER) — so you can test
 * the full voice flow by answering an incoming call, without dialing
 * internationally yourself.
 */
export function triggerTestCall() {
  return request("/voice/trigger-test-call", { method: "POST" });
}
