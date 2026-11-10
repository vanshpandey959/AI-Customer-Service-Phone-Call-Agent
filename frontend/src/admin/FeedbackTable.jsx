import DeleteButton from "./DeleteButton.jsx";

export default function FeedbackTable({ feedback, onViewCall, onDelete }) {
  if (feedback.length === 0) {
    return <p className="p-6 text-sm text-text-muted">No feedback recorded yet.</p>;
  }

  return (
    <div className="overflow-x-auto p-2">
      <table className="w-full text-left text-sm" style={{ borderCollapse: "separate", borderSpacing: "0 6px" }}>
        <thead>
          <tr className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            <th className="px-4 py-3">Message</th>
            <th className="px-4 py-3">Logged</th>
            <th className="px-4 py-3">Call</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {feedback.map((f) => (
            <tr key={f._id} className="rounded-xl bg-surface hover:bg-surface/70">
              <td className="max-w-md rounded-l-xl px-4 py-3 text-text">{f.message}</td>
              <td className="px-4 py-3 text-text-muted">{new Date(f.createdAt).toLocaleString()}</td>
              <td className="px-4 py-3">
                <button onClick={() => onViewCall(f.callId)} className="font-semibold text-primary hover:underline">
                  View call
                </button>
              </td>
              <td className="rounded-r-xl px-4 py-3">
                <DeleteButton onConfirm={() => onDelete(f._id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
