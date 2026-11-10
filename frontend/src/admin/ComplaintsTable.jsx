import Badge from "./Badge.jsx";
import DeleteButton from "./DeleteButton.jsx";

export default function ComplaintsTable({ complaints, onViewCall, onToggleStatus, onDelete }) {
  if (complaints.length === 0) {
    return <p className="p-6 text-sm text-text-muted">No complaints recorded yet.</p>;
  }

  return (
    <div className="overflow-x-auto p-2">
      <table className="w-full text-left text-sm" style={{ borderCollapse: "separate", borderSpacing: "0 6px" }}>
        <thead>
          <tr className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            <th className="px-4 py-3">Message</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Logged</th>
            <th className="px-4 py-3">Call</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {complaints.map((c) => (
            <tr key={c._id} className="rounded-xl bg-surface hover:bg-surface/70">
              <td className="max-w-md rounded-l-xl px-4 py-3 text-text">{c.message}</td>
              <td className="px-4 py-3">
                <Badge value={c.status} />
              </td>
              <td className="px-4 py-3 text-text-muted">{new Date(c.createdAt).toLocaleString()}</td>
              <td className="px-4 py-3">
                <button onClick={() => onViewCall(c.callId)} className="font-semibold text-primary hover:underline">
                  View call
                </button>
              </td>
              <td className="rounded-r-xl px-4 py-3">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => onToggleStatus(c._id, c.status === "pending" ? "resolved" : "pending")}
                    className="font-semibold text-primary hover:underline"
                  >
                    Mark {c.status === "pending" ? "resolved" : "pending"}
                  </button>
                  <DeleteButton onConfirm={() => onDelete(c._id)} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
