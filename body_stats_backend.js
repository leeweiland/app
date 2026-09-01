// body_stats_backend.js — bodyweight/stats time series ("track my body over
// time"), independent of any single scan. A body scan that includes weight
// also feeds this same series via recordWeightEntry (called directly, no
// HTTP round trip) so manual entries and scan-time entries share one chart.

import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, readJsonBody, sendJson } from "./chat_backend.js";

const STATS_FILE = "chat_body_stats.json";

// Called by body_analysis_backend.js (and, later, progress-photo uploads
// that include a weigh-in) -- not an HTTP route, just a shared write path.
export function recordWeightEntry(userId, { weightKg, heightCm = null, bodyFatPct = null, note = null, source = "manual", scanId = null, createdAt = null }) {
  if (!userId || !weightKg) return null;
  const all = readJson(STATS_FILE, {});
  if (!all[userId]) all[userId] = [];
  const entry = {
    id: randomUUID(),
    createdAt: createdAt || new Date().toISOString(),
    weightKg: Number(weightKg),
    heightCm: heightCm != null && heightCm !== "" ? Number(heightCm) : null,
    bodyFatPct: bodyFatPct != null && bodyFatPct !== "" ? Number(bodyFatPct) : null,
    note,
    source,
    scanId,
  };
  all[userId].push(entry);
  writeJson(STATS_FILE, all);
  return entry;
}

export async function handleBodyStatsRequest(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/body-stats/entries") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const all = readJson(STATS_FILE, {});
    // Ascending by createdAt -- chart-ready as-is; the frontend reverses its
    // own copy for the "most recent first" list view.
    const entries = (all[user.id] || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return sendJson(res, 200, { entries });
  }

  if (req.method === "POST" && url.pathname === "/api/body-stats/entries") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const body = await readJsonBody(req);
    if (!body.weightKg) return sendJson(res, 400, { error: "weightKg is required" });
    const entry = recordWeightEntry(user.id, {
      weightKg: body.weightKg, heightCm: body.heightCm, bodyFatPct: body.bodyFatPct,
      note: body.note || null, source: "manual", createdAt: body.createdAt || null,
    });
    return sendJson(res, 200, { entry });
  }

  const delMatch = url.pathname.match(/^\/api\/body-stats\/entries\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const id = delMatch[1];
    const all = readJson(STATS_FILE, {});
    if (all[user.id]) {
      all[user.id] = all[user.id].filter(e => e.id !== id);
      writeJson(STATS_FILE, all);
    }
    return sendJson(res, 200, { ok: true });
  }

  return false;
}
