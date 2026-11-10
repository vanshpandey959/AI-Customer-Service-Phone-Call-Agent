import { useEffect, useRef, useState } from "react";
import {
  fetchCalls,
  fetchCallDetail,
  fetchComplaints,
  fetchFeedback,
  deleteCall,
  deleteComplaint,
  deleteFeedback,
  updateComplaintStatus,
} from "../adminApi.js";
import CallsList from "./CallsList.jsx";
import CallDetail from "./CallDetail.jsx";
import ComplaintsTable from "./ComplaintsTable.jsx";
import FeedbackTable from "./FeedbackTable.jsx";
import StatsOverview from "./StatsOverview.jsx";
import CalendarView from "./CalendarView.jsx";
import TestCallTrigger from "./TestCallTrigger.jsx";
import { buildDailyStats } from "./dateStats.js";
import {
  IconDashboard,
  IconPhone,
  IconFlag,
  IconChat,
  IconSettings,
  IconHelp,
  IconLogout,
  IconSearch,
  IconMail,
  IconBell,
} from "./icons.jsx";

const NAV_ITEMS = [
  { tab: "Overview", label: "Dashboard", icon: IconDashboard },
  { tab: "Calls", label: "Calls", icon: IconPhone },
  { tab: "Complaints", label: "Complaints", icon: IconFlag },
  { tab: "Feedback", label: "Feedback", icon: IconChat },
];

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState("Overview");
  const [error, setError] = useState(null);

  const [calls, setCalls] = useState([]);
  const [complaints, setComplaints] = useState([]);
  const [feedback, setFeedback] = useState([]);

  const [selectedCallId, setSelectedCallId] = useState(null);
  const [selectedCall, setSelectedCall] = useState(null);
  const [callDetailLoading, setCallDetailLoading] = useState(false);
  const [callDetailError, setCallDetailError] = useState(null);

  useEffect(() => {
    loadAll();
  }, []);

  // Keep the dashboard live while calls are happening: refresh every 10 seconds (only while this
  // tab is visible), including the open call's transcript.
  const selectedCallIdRef = useRef(null);
  selectedCallIdRef.current = selectedCallId;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      loadAll();
      if (selectedCallIdRef.current) loadCallDetail(selectedCallIdRef.current, { silent: true });
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedCallId) return;
    loadCallDetail(selectedCallId);
  }, [selectedCallId]);

  async function loadAll() {
    try {
      const [callsData, complaintsData, feedbackData] = await Promise.all([
        fetchCalls(),
        fetchComplaints(),
        fetchFeedback(),
      ]);
      setCalls(callsData);
      setComplaints(complaintsData);
      setFeedback(feedbackData);
      setError(null);
    } catch (err) {
      setError("Couldn't load admin data. Is the backend running?");
    }
  }

  async function loadCallDetail(callId, { silent = false } = {}) {
    // silent: a background refresh, so no "Loading…" flicker and no error banner
    if (!silent) {
      setCallDetailLoading(true);
      setCallDetailError(null);
    }
    try {
      const data = await fetchCallDetail(callId);
      setSelectedCall(data);
    } catch (err) {
      if (!silent) setCallDetailError("Couldn't load this call.");
    } finally {
      if (!silent) setCallDetailLoading(false);
    }
  }

  function handleViewCall(callId) {
    setActiveTab("Calls");
    setSelectedCallId(callId);
  }

  async function handleDeleteCall(callId) {
    try {
      await deleteCall(callId);
      if (selectedCallId === callId) {
        setSelectedCallId(null);
        setSelectedCall(null);
      }
      await loadAll();
    } catch (err) {
      setError("Couldn't delete that call.");
    }
  }

  async function handleDeleteComplaint(complaintId) {
    try {
      await deleteComplaint(complaintId);
      setComplaints((prev) => prev.filter((c) => c._id !== complaintId));
      if (selectedCallId) loadCallDetail(selectedCallId);
    } catch (err) {
      setError("Couldn't delete that complaint.");
    }
  }

  async function handleDeleteFeedback(feedbackId) {
    try {
      await deleteFeedback(feedbackId);
      setFeedback((prev) => prev.filter((f) => f._id !== feedbackId));
      if (selectedCallId) loadCallDetail(selectedCallId);
    } catch (err) {
      setError("Couldn't delete that feedback.");
    }
  }

  async function handleToggleStatus(complaintId, newStatus) {
    try {
      const updated = await updateComplaintStatus(complaintId, newStatus);
      setComplaints((prev) => prev.map((c) => (c._id === complaintId ? updated : c)));
      if (selectedCallId) loadCallDetail(selectedCallId);
    } catch (err) {
      setError("Couldn't update that complaint's status.");
    }
  }

  const dailyStats = buildDailyStats(calls, complaints, feedback);
  const pendingComplaints = complaints.filter((c) => c.status === "pending").length;

  return (
    <div className="min-h-screen bg-bg p-3 sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-[1480px] gap-6 rounded-[28px] bg-surface p-3 shadow-[0_1px_2px_rgba(20,24,26,0.04)] sm:p-4 lg:p-6">
        {/* ---------------- Sidebar ---------------- */}
        <aside className="hidden w-60 shrink-0 flex-col lg:flex">
          <div className="flex items-center gap-2 px-2 pb-8 pt-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-primary text-primary">
              <IconPhone />
            </div>
            <span className="text-lg font-bold tracking-tight text-text">Chandigarh&nbsp;Cafe</span>
          </div>

          <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Menu</p>
          <nav className="space-y-1">
            {NAV_ITEMS.map(({ tab, label, icon: Icon }) => {
              const isActive = activeTab === tab;
              const count =
                tab === "Complaints" ? complaints.length : tab === "Feedback" ? feedback.length : null;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "border-l-4 border-primary bg-primary-light pl-2 text-primary"
                      : "border-l-4 border-transparent pl-2 text-text-muted hover:bg-surface-soft hover:text-text"
                  }`}
                >
                  <Icon />
                  <span className="flex-1 text-left">{label}</span>
                  {count > 0 && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-white">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <p className="px-2 pb-2 pt-8 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            General
          </p>
          <nav className="space-y-1">
            <div className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 pl-2 text-sm font-medium text-text-muted">
              <IconSettings />
              <span>Settings</span>
            </div>
            <div className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 pl-2 text-sm font-medium text-text-muted">
              <IconHelp />
              <span>Help</span>
            </div>
            <div className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 pl-2 text-sm font-medium text-text-muted">
              <IconLogout />
              <span>Logout</span>
            </div>
          </nav>

          <div className="mt-auto rounded-2xl bg-primary-dark p-4 text-white">
            <p className="text-sm font-semibold leading-snug">AI agent live on your Twilio number</p>
            <p className="mt-1 text-xs text-white/70">Twilio + Gnani speech + Groq, in English, Hindi and Punjabi.</p>
            <div className="mt-3">
              <TestCallTrigger compact />
            </div>
          </div>
        </aside>

        {/* ---------------- Main ---------------- */}
        <div className="min-w-0 flex-1">
          {/* Top bar */}
          <header className="flex flex-wrap items-center justify-between gap-3 pb-6">
            <div className="flex max-w-md flex-1 items-center gap-2 rounded-full border border-border bg-surface-soft px-4 py-2.5">
              <IconSearch className="text-text-muted" />
              <input
                placeholder="Search calls, complaints…"
                className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
              />
            </div>
            <div className="flex items-center gap-3">
              <button className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-text-muted hover:bg-surface-soft">
                <IconMail />
              </button>
              <button className="relative flex h-10 w-10 items-center justify-center rounded-full border border-border text-text-muted hover:bg-surface-soft">
                <IconBell />
                {pendingComplaints > 0 && (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger" />
                )}
              </button>
              <div className="flex items-center gap-2.5 pl-1">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary">
                  A
                </div>
                <div className="hidden sm:block">
                  <p className="text-sm font-semibold leading-tight text-text">Admin</p>
                  <p className="text-xs text-text-muted">Chandigarh Cafe and Restaurant</p>
                </div>
              </div>
            </div>
          </header>

          {/* Page heading */}
          <div className="flex flex-wrap items-center justify-between gap-4 pb-6">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-text">Dashboard</h1>
              <p className="mt-1 text-sm text-text-muted">Monitor calls, complaints and feedback in real time.</p>
            </div>
            <div className="lg:hidden">
              <TestCallTrigger />
            </div>
          </div>

          {error && (
            <div className="mb-6 rounded-xl border border-danger/30 bg-danger-light px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {/* Tabs (mobile-visible; sidebar already covers desktop nav) */}
          <div className="mb-6 flex gap-1 overflow-x-auto lg:hidden">
            {NAV_ITEMS.map(({ tab, label }) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab ? "bg-primary text-white" : "bg-surface-soft text-text-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {activeTab === "Overview" && (
            <StatsOverview
              calls={calls}
              complaints={complaints}
              feedback={feedback}
              dailyStats={dailyStats}
              onViewCall={handleViewCall}
              onGoToCalls={() => setActiveTab("Calls")}
            />
          )}

          {activeTab === "Calls" && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]" style={{ minHeight: "60vh" }}>
              <div className="rounded-2xl border border-border bg-surface-soft">
                <CallsList
                  calls={calls}
                  selectedId={selectedCallId}
                  onSelect={setSelectedCallId}
                  onDelete={handleDeleteCall}
                />
              </div>
              <div className="rounded-2xl border border-border bg-surface-soft">
                <CallDetail
                  call={selectedCall}
                  loading={callDetailLoading}
                  error={callDetailError}
                  onDelete={handleDeleteCall}
                />
              </div>
            </div>
          )}

          {activeTab === "Complaints" && (
            <div className="rounded-2xl border border-border bg-surface-soft">
              <ComplaintsTable
                complaints={complaints}
                onViewCall={handleViewCall}
                onToggleStatus={handleToggleStatus}
                onDelete={handleDeleteComplaint}
              />
            </div>
          )}

          {activeTab === "Feedback" && (
            <div className="rounded-2xl border border-border bg-surface-soft">
              <FeedbackTable feedback={feedback} onViewCall={handleViewCall} onDelete={handleDeleteFeedback} />
            </div>
          )}

          {activeTab === "Overview" && (
            <div className="mt-4">
              <CalendarView dailyStats={dailyStats} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
