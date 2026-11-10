const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
// Must match ADMIN_TOKEN in backend-node/.env (when that is set).
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN || "";

async function request(path, options) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      // ngrok's free plan answers browser requests with a warning page instead of the API
      // unless this header is present. Harmless when the API is not behind ngrok.
      "ngrok-skip-browser-warning": "true",
      ...(ADMIN_TOKEN ? { "x-admin-token": ADMIN_TOKEN } : {}),
    },
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
