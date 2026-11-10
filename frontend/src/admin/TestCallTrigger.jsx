import { useState } from "react";
import { triggerTestCall } from "../adminApi.js";
import { IconVideo } from "./icons.jsx";

export default function TestCallTrigger({ compact = false }) {
  const [status, setStatus] = useState("idle"); // idle | triggering | success | error
  const [message, setMessage] = useState(null);

  async function handleClick() {
    if (
      !window.confirm(
        "This will make your phone ring (an outbound call from your Twilio number). Uses a small amount of your Twilio balance. Continue?"
      )
    ) {
      return;
    }

    setStatus("triggering");
    setMessage(null);

    try {
      const result = await triggerTestCall();
      setStatus("success");
      setMessage(`Call triggered (${result.status}) — your phone should ring shortly. SID: ${result.callSid}`);
    } catch (err) {
      setStatus("error");
      setMessage(err.message || "Something went wrong triggering the call.");
    }
  }

  if (compact) {
    return (
      <>
        <button
          onClick={handleClick}
          disabled={status === "triggering"}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-white/15 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <IconVideo />
          {status === "triggering" ? "Calling…" : "Trigger test call"}
        </button>
        {message && (
          <p className={`mt-2 text-[11px] leading-snug ${status === "error" ? "text-red-200" : "text-white/80"}`}>
            {message}
          </p>
        )}
      </>
    );
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={status === "triggering"}
        className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        <IconVideo />
        {status === "triggering" ? "Calling…" : "Trigger test call"}
      </button>
      {message && (
        <p
          className={`mt-2 max-w-xs rounded-lg px-3 py-2 text-xs ${
            status === "success" ? "bg-success-light text-success" : "bg-danger-light text-danger"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
