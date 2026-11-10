import { useState } from "react";
import { dateKey } from "./dateStats.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function buildMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = firstDay.getDay(); // 0 = Sunday

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  return cells;
}

export default function CalendarView({ dailyStats }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed

  const cells = buildMonthGrid(year, month);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  function goPrevMonth() {
    if (month === 0) {
      setYear((y) => y - 1);
      setMonth(11);
    } else {
      setMonth((m) => m - 1);
    }
  }

  function goNextMonth() {
    if (month === 11) {
      setYear((y) => y + 1);
      setMonth(0);
    } else {
      setMonth((m) => m + 1);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-text">{monthLabel}</h3>
        <div className="flex gap-2">
          <button
            onClick={goPrevMonth}
            className="rounded-full border border-border px-2.5 py-1 text-sm text-text-muted hover:bg-surface-soft"
          >
            ←
          </button>
          <button
            onClick={goNextMonth}
            className="rounded-full border border-border px-2.5 py-1 text-sm text-text-muted hover:bg-surface-soft"
          >
            →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-text-muted">
        {WEEKDAYS.map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((date, i) => {
          if (!date) return <div key={`blank-${i}`} className="aspect-square" />;

          const key = dateKey(date);
          const entry = dailyStats[key];
          const isToday = dateKey(today) === key;

          return (
            <div
              key={key}
              className={`aspect-square rounded-md border p-1 text-left ${
                isToday ? "border-primary" : "border-border"
              } ${entry ? "bg-primary-light/30" : "bg-bg"}`}
            >
              <p className="text-xs font-medium text-text">{date.getDate()}</p>
              {entry && (
                <div className="mt-0.5 space-y-0.5">
                  {entry.calls > 0 && (
                    <p className="text-[10px] leading-tight text-primary">{entry.calls} call{entry.calls === 1 ? "" : "s"}</p>
                  )}
                  {entry.complaints > 0 && (
                    <p className="text-[10px] leading-tight text-danger">{entry.complaints} complaint{entry.complaints === 1 ? "" : "s"}</p>
                  )}
                  {entry.feedback > 0 && (
                    <p className="text-[10px] leading-tight text-feedback">{entry.feedback} feedback</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
