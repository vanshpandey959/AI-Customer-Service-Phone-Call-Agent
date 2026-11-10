import crypto from "node:crypto";
import { config } from "../config.js";

function sameSecret(given, expected) {
  // hash first so the comparison is constant-time even when the lengths differ
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Protects the dashboard API and the call-triggering routes. When this server is
 * reachable through ngrok, anyone who knows the URL could otherwise read call
 * transcripts and phone numbers, delete data, or make your Twilio number place calls.
 *
 * Set ADMIN_TOKEN in .env to turn it on. The token is accepted as an
 * "x-admin-token" header, an "Authorization: Bearer ..." header, or a ?token= query
 * parameter (handy for opening /voice/selfcheck in a browser).
 * With no ADMIN_TOKEN the routes stay open and server.js prints a warning at startup.
 */
export function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();

  const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const given = req.get("x-admin-token") || bearer || req.query.token || "";
  if (given && sameSecret(given, config.adminToken)) return next();

  res.status(401).json({ error: "Admin token required." });
}
