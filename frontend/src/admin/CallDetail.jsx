import Badge from "./Badge.jsx";
import DeleteButton from "./DeleteButton.jsx";

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function CallDetail({ call, loading, error, onDelete }) {
  if (loading) {
    return <p className="p-6 text-sm text-text-muted">Loading call…</p>;
  }
  if (error) {
    return <p className="p-6 text-sm text-danger">{error}</p>;
  }
  if (!call) {
    return <p className="p-6 text-sm text-text-muted">Select a call on the left to view its transcript.</p>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-text">Call detail</h2>
            <Badge value={call.status} />
            <Badge value={call.channel} />
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Started {new Date(call.startedAt).toLocaleString()}
            {call.endedAt && ` · Ended ${new Date(call.endedAt).toLocaleString()}`}
            {call.callerNumber && ` · ${call.callerNumber}`}
          </p>
        </div>
        <DeleteButton
          label="Delete call"
          confirmText="Delete this call and all its linked complaints/feedback? This cannot be undone."
          onConfirm={() => onDelete(call._id)}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Transcript</h3>
        <div className="space-y-3">
          {call.transcript.map((entry, i) => (
            <div
              key={i}
              className={`rounded-xl px-3 py-2 ${
                entry.role === "user" ? "bg-surface" : "bg-primary-light/40"
              }`}
            >
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="font-semibold text-text">{entry.role === "user" ? "Customer" : "Agent"}</span>
                <span>{formatTime(entry.timestamp)}</span>
                {entry.classification && entry.classification !== "normal" && <Badge value={entry.classification} />}
              </div>
              <p className="mt-0.5 text-sm text-text">{entry.content}</p>
            </div>
          ))}
        </div>

        {(call.complaints?.length > 0 || call.feedback?.length > 0) && (
          <div className="mt-6 space-y-4 border-t border-border pt-4">
            {call.complaints?.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Complaints from this call
                </h3>
                <ul className="space-y-2">
                  {call.complaints.map((c) => (
                    <li
                      key={c._id}
                      className="flex items-start justify-between gap-3 rounded-xl bg-danger-light px-3 py-2.5 text-sm text-text"
                    >
                      <span>{c.message}</span>
                      <Badge value={c.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {call.feedback?.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Feedback from this call
                </h3>
                <ul className="space-y-2">
                  {call.feedback.map((f) => (
                    <li key={f._id} className="rounded-xl bg-feedback-light px-3 py-2.5 text-sm text-text">
                      {f.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {call.status === "active" && (
          <p className="mt-6 text-xs text-text-muted">
            This call is still active — complaints/feedback are only finalized once the call ends.
          </p>
        )}
      </div>
    </div>
  );
}
