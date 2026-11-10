import Badge from "./Badge.jsx";
import DeleteButton from "./DeleteButton.jsx";
import { IconPhone } from "./icons.jsx";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CallsList({ calls, selectedId, onSelect, onDelete }) {
  if (calls.length === 0) {
    return <p className="p-5 text-sm text-text-muted">No calls yet.</p>;
  }

  return (
    <ul className="divide-y divide-border p-2">
      {calls.map((call) => (
        <li
          key={call.id}
          className={`rounded-xl p-3 transition-colors ${
            selectedId === call.id ? "bg-primary-light" : "hover:bg-surface"
          }`}
        >
          <button onClick={() => onSelect(call.id)} className="flex w-full items-start gap-3 text-left">
            <span
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                selectedId === call.id ? "bg-primary text-white" : "bg-surface text-primary"
              }`}
            >
              <IconPhone />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">{formatDate(call.startedAt)}</span>
                <Badge value={call.status} />
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Badge value={call.channel} />
                <span className="text-xs text-text-muted">
                  {call.messageCount} message{call.messageCount === 1 ? "" : "s"}
                </span>
              </div>
              {call.callerNumber && <p className="mt-1 truncate text-xs text-text-muted">{call.callerNumber}</p>}
            </div>
          </button>
          <div className="mt-2 text-right">
            <DeleteButton
              label="Delete call"
              confirmText="Delete this call and all its linked complaints/feedback? This cannot be undone."
              onConfirm={() => onDelete(call.id)}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
