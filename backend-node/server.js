import express from "express";
import cors from "cors";
import { config } from "./src/config.js";
import { connectDB } from "./src/db.js";
// import chatRouter from "./src/routes/chat.js";
import recordsRouter from "./src/routes/records.js";
import voiceRouter from "./src/routes/voice.js";

const app = express();

// Needed so req.protocol reflects the public https URL (ngrok, or a real
// deploy's load balancer) rather than the plain http Twilio's request
// actually arrives as internally — Twilio's webhook signature validation
// depends on reconstructing the exact URL it signed, https included.
app.set("trust proxy", true);

app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json()); // for the frontend's JSON requests (/api/*)
app.use(express.urlencoded({ extended: false })); // Twilio webhooks are form-encoded, not JSON

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// app.use("/api/chat", chatRouter);
app.use("/api", recordsRouter); // GET /api/calls, /api/calls/:id, /api/complaints, /api/feedback
app.use("/voice", voiceRouter); // Twilio webhooks: /voice/incoming, /voice/gather, /voice/status

// Last-resort error net for the voice routes: anything that escapes the
// per-route handlers must STILL answer with TwiML XML — Express's default
// JSON/HTML error response can't be parsed by Twilio, and it hangs the call
// up silently when the webhook errors.
app.use("/voice", (err, req, res, next) => {
  console.error("Voice route error:", err.message);
  if (res.headersSent) return res.end();
  res.status(200).type("text/xml").send(
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
      "<Say>Sorry, I'm having trouble responding right now. Could you repeat that?</Say>" +
      '<Gather input="speech" action="/voice/gather" method="POST" speechTimeout="auto" actionOnEmptyResult="true"/>' +
      "</Response>"
  );
});

// Catch-all error handler so unexpected errors don't crash the process
// or leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong." });
});

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Node backend listening on port ${config.port}`);
    console.log(`Proxying RAG requests to ${config.pythonServiceUrl}`);

    // Print the webhook URLs exactly as Twilio will call them — the trial
    // keypress is followed by a fetch of PUBLIC_BASE_URL/voice/incoming, so
    // a stale URL here IS the "trial notice, press any key, then hang up" bug.
    const base = config.publicBaseUrl || "⚠ PUBLIC_BASE_URL is NOT set";
    console.log(`Voice webhooks Twilio fetches (after the trial keypress):`);
    console.log(`  POST ${base}/voice/incoming`);
    console.log(`  POST ${base}/voice/gather`);
    console.log(`  POST ${base}/voice/status`);
    console.log(`  GET  ${base}/voice/selfcheck  ← run this before triggering a call`);
    if (!config.publicBaseUrl) {
      console.warn(
        "Calls will connect, play the trial notice, then hang up right after the keypress " +
          "until PUBLIC_BASE_URL is set to your CURRENT public URL (ngrok) in .env."
      );
    }
  });
}

start();
