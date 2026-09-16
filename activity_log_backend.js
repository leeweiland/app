// activity_log_backend.js — a plain, append-only per-user timeline of
// meaningful actions across the app (messages, reactions, nutrition,
// weigh-ins, scans, video sends, tab navigation, profile views). Every
// user gets one logged regardless of role; only an admin can ever read it
// back, via body-scan.html's Activity tab (Profile/ACTIVITY/Search).

import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, isAdmin, readJsonBody, sendJson } from "./chat_backend.js";

const LOG_FILE = "chat_activity_log.json";
// Oldest entries drop off past this per user so the file can't grow
// unbounded for a very active account -- generous enough that an admin
// scrolling back through the lazy-loaded feed won't realistically hit the
// edge under normal review.
const MAX_PER_USER = 3000;

// Called directly by other backend files at the point an action actually
// happens -- not a route. Never throws; a logging failure should never be
// allowed to break the real action that triggered it.
export function logActivity(userId, type, summary, meta = null) {
  if (!userId || !summary) return;
  try {
    const all = readJson(LOG_FILE, {});
    if (!all[userId]) all[userId] = [];
    all[userId].push({ id: randomUUID(), type, summary: String(summary).slice(0, 500), meta, createdAt: new Date().toISOString() });
    if (all[userId].length > MAX_PER_USER) all[userId] = all[userId].slice(all[userId].length - MAX_PER_USER);
    writeJson(LOG_FILE, all);
  } catch (e) {
    console.error("[activity-log]", e.message);
  }
}

export async function handleActivityLogRequest(req, res, url) {
  // Client-side events with no natural backend action to hang off of --
  // hub tab navigation, viewing another member's profile. Always logs
  // against the CALLER themselves, never an arbitrary userId, so this
  // can't be used to write into someone else's timeline.
  if (req.method === "POST" && url.pathname === "/api/activity/log") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const body = await readJsonBody(req);
    if (!body.type || !body.summary) return sendJson(res, 400, { error: "type and summary required" });
    logActivity(user.id, String(body.type).slice(0, 60), body.summary, body.meta || null);
    return sendJson(res, 200, { ok: true });
  }

  // Admin-only, paginated newest-first -- `before` is the createdAt of the
  // last entry already shown, so the Activity tab's scroll-triggered
  // lazy-load just keeps asking for "older than what I've got".
  if (req.method === "GET" && url.pathname === "/api/activity/log") {
    const requester = getSessionUser(req);
    if (!requester) return sendJson(res, 401, { error: "Not logged in" });
    if (!isAdmin(requester)) return sendJson(res, 403, { error: "Admin only" });
    const targetId = url.searchParams.get("userId") || requester.id;
    const before = url.searchParams.get("before");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);
    const entries = (readJson(LOG_FILE, {})[targetId] || []).slice().reverse();
    const startIdx = before ? entries.findIndex(e => e.createdAt < before) : 0;
    const from = startIdx < 0 ? entries.length : startIdx;
    const page = entries.slice(from, from + limit);
    const nextCursor = page.length === limit ? page[page.length - 1].createdAt : null;
    return sendJson(res, 200, { entries: page, nextCursor });
  }

  return false;
}
