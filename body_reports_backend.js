// body_reports_backend.js — daily/weekly/monthly rollups across the other
// body-tracking data files. Computed on request, nothing pre-stored --
// kept separate from body_stats_backend.js since this aggregates across
// four different files (food log, stats, photos, scans) rather than owning
// one of its own.

import { readJson, getSessionUser, resolveTargetUser, sendJson, isStaff, isAdmin } from "./chat_backend.js";

const FOOD_LOG_FILE = "chat_food_log.json";
const STATS_FILE = "chat_body_stats.json";
const PHOTOS_FILE = "chat_progress_photos.json";
const SCANS_FILE = "chat_body_scans.json";
const USERS_FILE = "chat_users.json";

function toDateKey(d) { return d.toISOString().slice(0, 10); }

// `date` anchors the period; returns [start, end] as Date objects covering
// the whole period, start at 00:00:00 and end at 23:59:59.999 local-ish
// (server runs in a single timezone -- consistent with how the rest of
// this app already handles dates, no per-user timezone handling anywhere).
function periodRange(period, anchorDate) {
  const d = new Date(anchorDate + "T12:00:00"); // noon avoids DST edge cases when walking to day boundaries
  if (period === "daily") {
    const start = new Date(anchorDate + "T00:00:00");
    const end = new Date(anchorDate + "T23:59:59.999");
    return [start, end];
  }
  if (period === "weekly") {
    const day = d.getDay(); // 0=Sun..6=Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d); monday.setDate(d.getDate() + mondayOffset); monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23, 59, 59, 999);
    return [monday, sunday];
  }
  // monthly
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return [start, end];
}

function inRange(iso, start, end) {
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

export async function handleBodyReportsRequest(req, res, url) {
  // Coach/admin "view any student's Physique Builder" search -- a coach's
  // pool is every non-staff user; an admin's pool is everyone, staff
  // included, per the explicit ask that admin can also pull up a coach's
  // own Physique Builder.
  if (req.method === "GET" && url.pathname === "/api/body-reports/search-users") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    let pool = readJson(USERS_FILE, []).filter(u => u.id !== user.id && !u.archived);
    if (!isAdmin(user)) pool = pool.filter(u => !isStaff(u));
    const filtered = (q ? pool.filter(u => `${u.first} ${u.last}`.toLowerCase().includes(q)) : pool)
      .sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`));
    const page = filtered.slice(offset, offset + limit)
      .map(u => ({ id: u.id, first: u.first, last: u.last, role: u.role }));
    return sendJson(res, 200, { users: page, hasMore: offset + limit < filtered.length });
  }

  if (req.method !== "GET" || url.pathname !== "/api/body-reports/summary") return false;

  const user = resolveTargetUser(req, url);
  if (!user) return sendJson(res, 401, { error: "Not logged in" });

  const period = ["daily", "weekly", "monthly"].includes(url.searchParams.get("period")) ? url.searchParams.get("period") : "daily";
  const anchor = url.searchParams.get("date") || toDateKey(new Date());
  const [start, end] = periodRange(period, anchor);

  // ── Nutrition: chat_food_log.json is keyed by date string, not a flat
  // array -- walk each day in range rather than filtering every entry ever
  // logged by this user.
  const byDate = readJson(FOOD_LOG_FILE, {})[user.id] || {};
  let totalEntries = 0, sumCal = 0, sumProtein = 0, sumFat = 0, sumCarb = 0, daysLogged = 0;
  for (const key of Object.keys(byDate)) {
    const dayDate = new Date(key + "T12:00:00");
    if (dayDate < start || dayDate > end) continue;
    const entries = byDate[key];
    if (!entries.length) continue;
    daysLogged++;
    for (const e of entries) {
      totalEntries++;
      sumCal += e.calories || 0;
      sumProtein += e.macros?.proteinG || 0;
      sumFat += e.macros?.fatG || 0;
      sumCarb += e.macros?.carbG || 0;
    }
  }
  const nutrition = {
    daysLogged, totalEntries,
    avgCalories: daysLogged ? Math.round(sumCal / daysLogged) : 0,
    avgProteinG: daysLogged ? Math.round(sumProtein / daysLogged) : 0,
    avgFatG: daysLogged ? Math.round(sumFat / daysLogged) : 0,
    avgCarbG: daysLogged ? Math.round(sumCarb / daysLogged) : 0,
  };

  // ── Weight ──
  const statEntries = (readJson(STATS_FILE, {})[user.id] || [])
    .filter(e => inRange(e.createdAt, start, end))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const weights = statEntries.map(e => e.weightKg);
  const weight = {
    entries: statEntries,
    startWeightKg: weights.length ? weights[0] : null,
    endWeightKg: weights.length ? weights[weights.length - 1] : null,
    deltaKg: weights.length >= 2 ? Math.round((weights[weights.length - 1] - weights[0]) * 10) / 10 : null,
    minKg: weights.length ? Math.min(...weights) : null,
    maxKg: weights.length ? Math.max(...weights) : null,
  };

  // ── Photos ──
  const photoEntries = (readJson(PHOTOS_FILE, {})[user.id] || []).filter(p => inRange(p.createdAt, start, end));
  const photos = { count: photoEntries.length, driveFileIds: photoEntries.map(p => p.driveFileId) };

  // ── Scans ──
  const scanEntries = (readJson(SCANS_FILE, {})[user.id] || []).filter(s => inRange(s.createdAt, start, end));
  const scans = { count: scanEntries.length };

  return sendJson(res, 200, {
    period, rangeStart: start.toISOString(), rangeEnd: end.toISOString(),
    nutrition, weight, photos, scans,
  });
}
