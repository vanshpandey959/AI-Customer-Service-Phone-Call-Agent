/** Formats a Date (or ISO string) as a local YYYY-MM-DD key. */
function dateKey(dateLike) {
  const d = new Date(dateLike);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Groups calls/complaints/feedback by the day they occurred, returning a
 * plain object keyed by "YYYY-MM-DD" -> { calls, complaints, feedback }.
 * Calls are bucketed by startedAt; complaints/feedback by createdAt.
 */
export function buildDailyStats(calls, complaints, feedback) {
  const stats = {};

  function bump(key, field) {
    if (!stats[key]) stats[key] = { calls: 0, complaints: 0, feedback: 0 };
    stats[key][field] += 1;
  }

  calls.forEach((c) => bump(dateKey(c.startedAt), "calls"));
  complaints.forEach((c) => bump(dateKey(c.createdAt), "complaints"));
  feedback.forEach((f) => bump(dateKey(f.createdAt), "feedback"));

  return stats;
}

export { dateKey };
