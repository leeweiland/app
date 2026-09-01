// body_stats_backend.js — bodyweight/stats time series ("track my body over
// time"), independent of any single scan. A body scan that includes weight
// also feeds this same series via recordWeightEntry (called directly, no
// HTTP round trip) so manual entries and scan-time entries share one chart.

import { Readable } from "stream";
import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, readJsonBody, sendJson, getDriveAccessToken, uploadStreamToDrive, streamDriveMedia } from "./chat_backend.js";
import { parseMultipartUpload } from "./multipart_util.js";
import { calcCalorieTarget, calcMacros, buildMealPlan } from "./nutrition_calc.js";

const STATS_FILE = "chat_body_stats.json";
const PHOTOS_FILE = "chat_progress_photos.json";
const PROFILE_FILE = "chat_body_profile.json";
// TODO(lee): replace with a real Drive folder id once created and shared
// with the GOOGLE_REFRESH_TOKEN_PRA account -- same pattern as
// body_analysis_backend.js's SCAN_PHOTOS_FOLDER. Uploads fail loudly (400)
// until this is a real folder, rather than silently saving an unusable
// photo-less record.
const PROGRESS_PHOTOS_FOLDER = "REPLACE_WITH_REAL_DRIVE_FOLDER_ID";

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

// Most recent weigh-in regardless of source (manual, scan, or the Food Log
// profile's own "current weight" field) -- called by body_analysis_backend.js
// so a scan run without an explicit weight still gets a real calorie/macro
// plan instead of none at all.
export function getLatestWeightKg(userId) {
  const entries = readJson(STATS_FILE, {})[userId] || [];
  if (!entries.length) return null;
  return entries.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0].weightKg;
}

// Most recent entry specifically tagged as a weekly check-in (as opposed to
// any other weigh-in) -- used both by the frontend's "check-in due" status
// and by chat_backend.js's reminder poll.
export function getLastCheckinAt(userId) {
  const entries = (readJson(STATS_FILE, {})[userId] || []).filter(e => e.source === "checkin");
  if (!entries.length) return null;
  return entries.reduce((latest, e) => (new Date(e.createdAt) > new Date(latest) ? e.createdAt : latest), entries[0].createdAt);
}

// Profile (height/age/sex/activity/goal/goal-weight) + the latest weigh-in
// combine into a calorie/macro estimate -- shared by the profile routes
// below and by body_analysis_backend.js's fallback when a scan doesn't
// supply its own explicit values.
export function estimateFromProfile(profile, weightKg) {
  if (!profile?.heightCm || !weightKg) return { calorieTarget: null, macros: null, mealPlan: null };
  const calorieTarget = calcCalorieTarget({
    heightCm: profile.heightCm, weightKg, age: profile.age, sex: profile.sex,
    activityLevel: profile.activityLevel, goal: profile.goal,
  });
  const macros = calcMacros(calorieTarget);
  const mealPlan = buildMealPlan(macros, calorieTarget);
  return { calorieTarget, macros, mealPlan };
}

export async function handleBodyStatsRequest(req, res, url) {
  // ── Profile (height/age/sex/goal weight/activity/goal) ─────────────────
  if (req.method === "GET" && url.pathname === "/api/body-stats/profile") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const profile = readJson(PROFILE_FILE, {})[user.id] || null;
    const weightKg = getLatestWeightKg(user.id);
    const estimate = estimateFromProfile(profile, weightKg);
    return sendJson(res, 200, { profile, weightKg, ...estimate });
  }

  if (req.method === "POST" && url.pathname === "/api/body-stats/profile") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const body = await readJsonBody(req);
    const all = readJson(PROFILE_FILE, {});
    const profile = {
      heightCm: body.heightCm ? Number(body.heightCm) : null,
      age: body.age ? Number(body.age) : null,
      sex: body.sex || null,
      goalWeightKg: body.goalWeightKg ? Number(body.goalWeightKg) : null,
      activityLevel: body.activityLevel || null,
      goal: body.goal || null,
      updatedAt: new Date().toISOString(),
    };
    all[user.id] = profile;
    writeJson(PROFILE_FILE, all);

    // Entering "current weight" alongside the profile is a weigh-in, same
    // as the Stats-tab entry it replaced.
    if (body.weightKg) recordWeightEntry(user.id, { weightKg: body.weightKg, heightCm: profile.heightCm, source: "manual" });

    const weightKg = getLatestWeightKg(user.id);
    const estimate = estimateFromProfile(profile, weightKg);
    return sendJson(res, 200, { profile, weightKg, ...estimate });
  }

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

  // ── Weekly check-in status ──────────────────────────────────────────────
  // The check-in itself isn't a separate action anymore -- one photo area on
  // the Physique Scan tab does both (see body_analysis_backend.js's
  // /api/body-scan/analyze, which tags its weight entry "checkin" whenever
  // a fresh weight was submitted alongside the photo). This just reports
  // status off that same getLastCheckinAt() read.
  if (req.method === "GET" && url.pathname === "/api/body-stats/checkin-status") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const lastCheckinAt = getLastCheckinAt(user.id);
    const daysSince = lastCheckinAt ? (Date.now() - new Date(lastCheckinAt).getTime()) / 86400000 : null;
    return sendJson(res, 200, { lastCheckinAt, dueThisWeek: daysSince == null || daysSince >= 7 });
  }

  // ── Progress photos ───────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/body-stats/photos") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const { fields, image } = await parseMultipartUpload(req);
    if (!image) return sendJson(res, 400, { error: "photo is required" });

    let uploaded;
    try {
      const accessToken = await getDriveAccessToken();
      const ext = image.mimeType.includes("png") ? ".png" : image.mimeType.includes("webp") ? ".webp" : ".jpg";
      const date = new Date().toISOString().slice(0, 10);
      uploaded = await uploadStreamToDrive(Readable.from(image.buffer), {
        name: `${user.first} ${user.last} PROGRESS PHOTO ${date}`.toUpperCase() + ext,
        mimeType: image.mimeType,
        folderId: PROGRESS_PHOTOS_FOLDER,
        accessToken,
      });
    } catch (e) {
      console.error("[progress-photos] Drive upload failed:", e.message);
      return sendJson(res, 500, { error: "Photo upload failed, try again" });
    }

    const entry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      driveFileId: uploaded.id,
      mimeType: image.mimeType,
      note: fields.note || null,
      weightKg: fields.weightKg || null,
      linkedScanId: null,
    };
    const all = readJson(PHOTOS_FILE, {});
    if (!all[user.id]) all[user.id] = [];
    all[user.id].push(entry);
    writeJson(PHOTOS_FILE, all);

    // Uploading with a weight double as a weigh-in, same as a scan does.
    if (fields.weightKg) recordWeightEntry(user.id, { weightKg: fields.weightKg, source: "manual" });

    return sendJson(res, 200, { entry });
  }

  if (req.method === "GET" && url.pathname === "/api/body-stats/photos") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const all = readJson(PHOTOS_FILE, {});
    const photos = (all[user.id] || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return sendJson(res, 200, { photos });
  }

  const delPhotoMatch = url.pathname.match(/^\/api\/body-stats\/photos\/([^/]+)$/);
  if (delPhotoMatch && req.method === "DELETE") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const id = delPhotoMatch[1];
    const all = readJson(PHOTOS_FILE, {});
    if (all[user.id]) {
      all[user.id] = all[user.id].filter(p => p.id !== id);
      writeJson(PHOTOS_FILE, all);
    }
    return sendJson(res, 200, { ok: true });
  }

  // Authorization-scoped Drive read proxy -- the fileId must belong to a
  // progress photo OR a body/move scan owned by the requester (scans get
  // photos through here too now, rather than only ever being fetched
  // through Drive's own share link).
  const mediaMatch = url.pathname.match(/^\/api\/body-stats\/media\/([^/]+)$/);
  if (mediaMatch && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user) { res.writeHead(401); res.end(); return true; }
    const fileId = mediaMatch[1];
    const ownPhotos = readJson(PHOTOS_FILE, {})[user.id] || [];
    const ownScans = readJson("chat_body_scans.json", {})[user.id] || [];
    const owns = ownPhotos.some(p => p.driveFileId === fileId) || ownScans.some(s => s.driveFileId === fileId);
    if (!owns) { res.writeHead(403); res.end(); return true; }
    try {
      const accessToken = await getDriveAccessToken();
      await streamDriveMedia(req, res, fileId, accessToken);
    } catch (e) {
      res.writeHead(500); res.end("Media fetch failed: " + e.message);
    }
    return true;
  }

  return false;
}
