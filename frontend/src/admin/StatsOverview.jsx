import { PieChart, Pie, Cell } from "recharts";
import { dateKey } from "./dateStats.js";
import { IconArrowUpRight, IconPhone, IconFlag, IconChat } from "./icons.jsx";
import Badge from "./Badge.jsx";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/** Current week (Sun→Sat) call counts, for the capsule bar chart. */
function currentWeekCallCounts(calls) {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay());

  const counts = new Array(7).fill(0);
  const byDay = {};
  calls.forEach((c) => {
    const key = dateKey(c.startedAt);
    byDay[key] = (byDay[key] || 0) + 1;
  });

  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    counts[i] = byDay[dateKey(d)] || 0;
  }
  return counts;
}

function StatCard({ label, value, sublabel, highlighted }) {
  return (
    <div
      className={`relative rounded-2xl p-5 ${
        highlighted ? "bg-primary text-white" : "border border-border bg-surface text-text"
      }`}
    >
      <div className="flex items-start justify-between">
        <p className={`text-sm font-medium ${highlighted ? "text-white/85" : "text-text-muted"}`}>{label}</p>
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full border ${
            highlighted ? "border-white/30 text-white" : "border-border text-text-muted"
          }`}
        >
          <IconArrowUpRight />
        </span>
      </div>
      <p className="mt-3 text-4xl font-bold tracking-tight">{value}</p>
      {sublabel && (
        <p className={`mt-3 text-xs font-medium ${highlighted ? "text-white/75" : "text-text-muted"}`}>
          {sublabel}
        </p>
      )}
    </div>
  );
}

function CallVolumeCard({ calls }) {
  const counts = currentWeekCallCounts(calls);
  const max = Math.max(...counts, 1);
  const peakIndex = counts.indexOf(Math.max(...counts));

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <h3 className="text-base font-semibold text-text">Call Volume</h3>
      <p className="text-xs text-text-muted">Calls received this week</p>
      <div className="mt-6 flex h-40 items-end justify-between gap-2 sm:gap-3">
        {counts.map((count, i) => {
          const heightPct = count === 0 ? 18 : Math.max(28, Math.round((count / max) * 100));
          const isPeak = count > 0 && i === peakIndex;
          return (
            <div key={i} className="relative flex flex-1 flex-col items-center">
              {isPeak && (
                <span className="mb-1 rounded-full bg-surface-soft px-2 py-0.5 text-[10px] font-semibold text-text">
                  {count} call{count === 1 ? "" : "s"}
                </span>
              )}
              <div
                className={`w-full rounded-full ${count === 0 ? "bg-[repeating-linear-gradient(135deg,var(--color-border)_0px,var(--color-border)_2px,transparent_2px,transparent_6px)]" : isPeak ? "bg-primary" : "bg-accent/70"}`}
                style={{ height: `${heightPct}%` }}
              />
              <span className="mt-2 text-xs font-medium text-text-muted">{WEEKDAY_LABELS[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LatestComplaintCard({ complaints, onViewCall }) {
  const latestPending = [...complaints]
    .filter((c) => c.status === "pending")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <h3 className="text-base font-semibold text-text">Needs attention</h3>
      {latestPending ? (
        <>
          <p className="mt-3 text-lg font-semibold leading-snug text-text">{latestPending.message}</p>
          <p className="mt-2 text-xs text-text-muted">
            Logged {new Date(latestPending.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
          <button
            onClick={() => onViewCall(latestPending.callId)}
            className="mt-4 flex items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            View call
          </button>
        </>
      ) : (
        <p className="mt-3 text-sm text-text-muted">No pending complaints right now — all clear.</p>
      )}
    </div>
  );
}

function RecentCallsCard({ calls, onGoToCalls }) {
  const recent = [...calls]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 5);

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-text">Recent calls</h3>
        <button
          onClick={onGoToCalls}
          className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-text-muted hover:bg-surface-soft"
        >
          View all
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No calls yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {recent.map((call) => (
            <li key={call.id} className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
                <IconPhone />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {call.callerNumber || (call.channel === "web" ? "Web chat test" : "Phone call")}
                </p>
                <p className="text-xs text-text-muted">
                  {new Date(call.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </p>
              </div>
              <Badge value={call.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityListCard({ complaints, feedback, onViewCall }) {
  const items = [
    ...complaints.map((c) => ({ ...c, kind: "complaint" })),
    ...feedback.map((f) => ({ ...f, kind: "feedback" })),
  ]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);

  return (
    <div className="rounded-2xl border border-border bg-surface p-5 lg:col-span-2">
      <h3 className="text-base font-semibold text-text">Complaints &amp; feedback</h3>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">Nothing logged yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {items.map((item) => (
            <li key={item._id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  item.kind === "complaint" ? "bg-danger-light text-danger" : "bg-feedback-light text-feedback"
                }`}
              >
                {item.kind === "complaint" ? <IconFlag /> : <IconChat />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{item.message}</p>
                <p className="text-xs text-text-muted">
                  {new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </p>
              </div>
              {item.kind === "complaint" && <Badge value={item.status} />}
              <button
                onClick={() => onViewCall(item.callId)}
                className="shrink-0 text-xs font-semibold text-primary hover:underline"
              >
                View call
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResolutionDonut({ complaints }) {
  const resolved = complaints.filter((c) => c.status === "resolved").length;
  const pending = complaints.filter((c) => c.status === "pending").length;
  const total = resolved + pending;
  const pct = total ? Math.round((resolved / total) * 100) : 0;

  const data = total
    ? [
        { name: "Resolved", value: resolved, color: "var(--color-primary)" },
        { name: "Pending", value: pending, color: "var(--color-border)" },
      ]
    : [{ name: "None", value: 1, color: "var(--color-border)" }];

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <h3 className="text-base font-semibold text-text">Resolution rate</h3>
      <div className="relative mx-auto mt-2 h-44 w-44">
        <PieChart width={176} height={176}>
          <Pie data={data} dataKey="value" innerRadius={62} outerRadius={82} startAngle={90} endAngle={-270} stroke="none">
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold text-text">{pct}%</span>
          <span className="text-xs text-text-muted">Resolved</span>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-4 text-xs text-text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" /> Resolved
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-border" /> Pending
        </span>
      </div>
    </div>
  );
}

function LiveCallCard({ calls }) {
  const active = calls.find((c) => c.status === "active");

  return (
    <div className="relative overflow-hidden rounded-2xl bg-primary-dark p-5 text-white">
      <h3 className="text-base font-semibold">Live call</h3>
      {active ? (
        <>
          <p className="mt-6 text-3xl font-bold tabular-nums">In progress</p>
          <p className="mt-1 text-xs text-white/70">
            Started {new Date(active.startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            {active.callerNumber ? ` · ${active.callerNumber}` : ""}
          </p>
        </>
      ) : (
        <>
          <p className="mt-6 text-2xl font-bold">No live calls</p>
          <p className="mt-1 text-xs text-white/70">Trigger a test call from the sidebar to try it live.</p>
        </>
      )}
    </div>
  );
}

export default function StatsOverview({ calls, complaints, feedback, onViewCall, onGoToCalls }) {
  const total = calls.length;
  const ended = calls.filter((c) => c.status === "ended").length;
  const active = calls.filter((c) => c.status === "active").length;
  const pendingComplaints = complaints.filter((c) => c.status === "pending").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Calls" value={total} sublabel="All time" highlighted />
        <StatCard label="Ended Calls" value={ended} sublabel="Completed conversations" />
        <StatCard label="Active Calls" value={active} sublabel="In progress right now" />
        <StatCard label="Pending Complaints" value={pendingComplaints} sublabel="Awaiting review" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CallVolumeCard calls={calls} />
        <LatestComplaintCard complaints={complaints} onViewCall={onViewCall} />
        <RecentCallsCard calls={calls} onGoToCalls={onGoToCalls} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <ActivityListCard complaints={complaints} feedback={feedback} onViewCall={onViewCall} />
        <ResolutionDonut complaints={complaints} />
        <LiveCallCard calls={calls} />
      </div>
    </div>
  );
}
