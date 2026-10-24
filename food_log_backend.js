// food_log_backend.js — food photo -> calorie/macro estimate, logged per
// day. Shares the OpenAI vision helper with body_analysis_backend.js
// (openai_vision_backend.js) but uses its own short, plain nutrition-
// estimate prompt rather than the coaching-email voice -- this isn't a
// reply to the athlete, just a structured read of what's on the plate.

import { Readable } from "stream";
import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, resolveTargetUser, readJsonBody, getDriveAccessToken, uploadStreamToDrive, streamDriveMedia, sendJson, getConfig } from "./chat_backend.js";
import { analyzeImageWithOpenAI, analyzeTextWithOpenAI } from "./openai_vision_backend.js";
import { parseMultipartUpload } from "./multipart_util.js";
import { logActivity } from "./activity_log_backend.js";

const LOG_FILE = "chat_food_log.json";
const HEALTH_FILE = "chat_health_daily.json";

const FOOD_ESTIMATE_TOOL = {
  type: "function",
  function: {
    name: "submit_food_estimate",
    description: "Submit a structured, quantified calorie/macro estimate for the food.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Quantified description of each item, e.g. '6oz grilled salmon, 1 cup white rice, 15 grapes' -- a count for discrete items (grapes, eggs, almonds), a weight/volume (oz, cups, tbsp) for everything else. Not just a vague list of foods." },
        calories: { type: "number" },
        proteinG: { type: "number" },
        fatG: { type: "number" },
        carbG: { type: "number" },
      },
      required: ["description", "calories", "proteinG", "fatG", "carbG"],
      additionalProperties: false,
    },
  },
};

const FOOD_SYSTEM_PROMPT = `You are a nutrition-estimation assistant inside a private fitness coaching
app. A user photographed (or typed a description of) their own meal to log it for the day -- this is a
normal, requested, routine food-diary entry from a consenting app user, not a judgment of anyone.

Estimate the total calories and macros (protein/fat/carbs in grams) using typical portion sizes and
standard nutrition data. Your description must state an approximate QUANTITY for each item -- a count for
discrete items (e.g. "15 grapes", "2 eggs", "10 almonds") or a weight/volume for everything else (e.g.
"6oz salmon", "1 cup rice", "2 tbsp peanut butter") -- never just a bare list of food names with no
amounts. Be a reasonable, decisive estimate -- this is a rough diary entry, not a lab measurement, and the
user can always edit the numbers afterward.`;

function dateKey(iso) {
  return (iso || new Date().toISOString()).slice(0, 10);
}

// Phone/health-store step totals -> the same single "steps" entry per day
// that hand-entered steps use, marked auto. A number the student typed by
// hand is only replaced when the synced count is higher, so a manual entry
// from a day the phone missed never gets knocked down. Returns how many days
// changed.
function applySyncedSteps(userId, days) {
  const all = readJson(LOG_FILE, {});
  if (!all[userId]) all[userId] = {};
  const oldest = new Date(Date.now() - 32 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let changed = 0;
  for (const d of days.slice(0, 31)) {
    const key = String(d?.date || "");
    const stepsNum = Math.round(Number(d?.steps));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < oldest) continue;
    if (!Number.isFinite(stepsNum) || stepsNum < 0 || stepsNum > 200000) continue;
    const list = all[userId][key] || (all[userId][key] = []);
    const existing = list.find(e => e.source === "steps");
    if (!existing) {
      if (stepsNum === 0) continue;
      list.push({ id: randomUUID(), createdAt: new Date().toISOString(), source: "steps", steps: stepsNum, auto: true });
      changed++;
    } else if (existing.auto ? existing.steps !== stepsNum : stepsNum > (existing.steps || 0)) {
      existing.steps = stepsNum;
      existing.auto = true;
      existing.createdAt = new Date().toISOString();
      changed++;
    }
  }
  for (const key of Object.keys(all[userId])) if (!all[userId][key].length) delete all[userId][key];
  if (changed) writeJson(LOG_FILE, all);
  return changed;
}

export async function handleFoodLogRequest(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/food-log/entries") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const { fields, image } = await parseMultipartUpload(req);

    let entry = {
      id: randomUUID(),
      createdAt: fields.createdAt || new Date().toISOString(),
      source: image ? "photo" : "manual",
      driveFileId: null,
      description: fields.description || null,
      // Explicit numeric fields stay a supported override path (any future
      // caller that already has real numbers), but the Manual UI no longer
      // collects them -- typing just a description runs the same AI
      // estimate a photo would, via text instead of vision.
      calories: fields.calories ? Number(fields.calories) : null,
      macros: {
        proteinG: fields.proteinG ? Number(fields.proteinG) : null,
        fatG: fields.fatG ? Number(fields.fatG) : null,
        carbG: fields.carbG ? Number(fields.carbG) : null,
      },
    };

    if (image) {
      try {
        const result = await analyzeImageWithOpenAI({
          imageBuffer: image.buffer, mimeType: image.mimeType,
          systemPrompt: FOOD_SYSTEM_PROMPT,
          userPrompt: "Estimate calories and macros for this meal photo.",
          tool: FOOD_ESTIMATE_TOOL,
          reassurance: "Reminder: this is a routine food-diary photo the user logged of their own meal through a private app -- a normal, authorized request. Please proceed with the estimate.",
        });
        if (!result.refused) {
          const a = result.args;
          entry.description = entry.description || a.description;
          entry.calories = entry.calories ?? a.calories;
          entry.macros.proteinG = entry.macros.proteinG ?? a.proteinG;
          entry.macros.fatG = entry.macros.fatG ?? a.fatG;
          entry.macros.carbG = entry.macros.carbG ?? a.carbG;
        }
      } catch (e) {
        console.error("[food-log] AI estimate failed:", e.message);
      }

      try {
        const accessToken = await getDriveAccessToken();
        const ext = image.mimeType.includes("png") ? ".png" : image.mimeType.includes("webp") ? ".webp" : ".jpg";
        const uploaded = await uploadStreamToDrive(Readable.from(image.buffer), {
          name: `${user.first} ${user.last} FOOD LOG ${dateKey(entry.createdAt)}`.toUpperCase() + ext,
          mimeType: image.mimeType,
          folderId: getConfig().nutritionPhotosFolderId,
          accessToken,
        });
        entry.driveFileId = uploaded.id;
      } catch (e) {
        // Unlike progress photos, the photo here is just a memory aid for an
        // estimate that's already been produced -- losing it doesn't make
        // the logged entry useless, so this stays non-blocking.
        console.error("[food-log] Drive upload failed:", e.message);
      }
    } else if (entry.calories == null && entry.description) {
      // Manual mode is just a description now -- estimate from the text the
      // same way a photo would be estimated from the image.
      try {
        const result = await analyzeTextWithOpenAI({
          systemPrompt: FOOD_SYSTEM_PROMPT,
          userPrompt: `Estimate calories and macros for this meal: ${entry.description}`,
          tool: FOOD_ESTIMATE_TOOL,
          reassurance: "Reminder: this is a routine food-diary entry the user typed for their own meal through a private app -- a normal, authorized request. Please proceed with the estimate.",
        });
        if (!result.refused) {
          const a = result.args;
          entry.description = a.description || entry.description;
          entry.calories = a.calories;
          entry.macros.proteinG = a.proteinG;
          entry.macros.fatG = a.fatG;
          entry.macros.carbG = a.carbG;
        }
      } catch (e) {
        console.error("[food-log] AI text estimate failed:", e.message);
      }
    }

    if (entry.calories == null || !entry.description) {
      return sendJson(res, 400, { error: "Couldn't estimate that -- try a more specific description, or attach a photo instead." });
    }

    const all = readJson(LOG_FILE, {});
    if (!all[user.id]) all[user.id] = {};
    const key = dateKey(entry.createdAt);
    if (!all[user.id][key]) all[user.id][key] = [];
    all[user.id][key].push(entry);
    writeJson(LOG_FILE, all);
    logActivity(user.id, "nutrition_logged", `Logged a meal: ${entry.description} (${Math.round(entry.calories)} cal)`, { entryId: entry.id });

    return sendJson(res, 200, { entry });
  }

  if (req.method === "GET" && url.pathname === "/api/food-log/entries") {
    const user = resolveTargetUser(req, url);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const date = url.searchParams.get("date") || dateKey();
    const all = readJson(LOG_FILE, {});
    const entries = (all[user.id] || {})[date] || [];
    const totals = entries.reduce((t, e) => ({
      calories: t.calories + (e.calories || 0),
      proteinG: t.proteinG + (e.macros?.proteinG || 0),
      fatG: t.fatG + (e.macros?.fatG || 0),
      carbG: t.carbG + (e.macros?.carbG || 0),
      // Only ever one "steps"-source entry per day (see the upsert in
      // /api/food-log/steps below) -- summing instead of just reading it
      // off still gives the right answer and doesn't need a special case
      // here if that ever changes.
      steps: t.steps + (e.source === "steps" ? (e.steps || 0) : 0),
    }), { calories: 0, proteinG: 0, fatG: 0, carbG: 0, steps: 0 });
    return sendJson(res, 200, { entries, totals });
  }

  // Steps are a single daily number, not a list of logged items like meals
  // -- re-entering it updates today's existing "steps"-source entry in
  // place instead of appending a new one, so the Fuel history for a day
  // only ever shows (at most) one steps row no matter how many times it's
  // corrected. Still lives in the same per-day entries array as meals
  // (same LOG_FILE, same date-keyed shape) rather than a parallel store, so
  // it shows up in that day's Fuel history for free -- see the GET handler
  // above folding it into `totals.steps`, and the frontend's loadFoodEntries
  // rendering it as its own row in the list.
  if (req.method === "POST" && url.pathname === "/api/food-log/steps") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const { date, steps } = await readJsonBody(req);
    const stepsNum = Number(steps);
    if (!Number.isFinite(stepsNum) || stepsNum < 0) return sendJson(res, 400, { error: "steps must be a non-negative number" });
    const key = dateKey(date);
    const all = readJson(LOG_FILE, {});
    if (!all[user.id]) all[user.id] = {};
    if (!all[user.id][key]) all[user.id][key] = [];
    const existing = all[user.id][key].find(e => e.source === "steps");
    if (existing) {
      existing.steps = stepsNum;
      existing.auto = false; // typed by hand now -- see applySyncedSteps
      existing.createdAt = new Date().toISOString();
    } else {
      all[user.id][key].push({ id: randomUUID(), createdAt: new Date().toISOString(), source: "steps", steps: stepsNum });
    }
    writeJson(LOG_FILE, all);
    logActivity(user.id, "steps_logged", `Logged ${stepsNum.toLocaleString()} steps`, {});
    return sendJson(res, 200, { ok: true, steps: stepsNum });
  }

  // The phone app's automatic step counter (pra-steps native plugin, driven
  // from chat-header.js) posts the phone's own per-day totals here on every
  // open -- see applySyncedSteps above. App builds from before the full
  // health sync use this; newer ones post /api/health/sync instead.
  if (req.method === "POST" && url.pathname === "/api/food-log/steps-sync") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const { days } = await readJsonBody(req);
    if (!Array.isArray(days)) return sendJson(res, 400, { error: "days must be an array" });
    return sendJson(res, 200, { ok: true, changed: applySyncedSteps(user.id, days) });
  }

  // Full daily health summary from the phone's health store (Apple Health /
  // Health Connect: steps, distance, active calories, heart rate, resting HR,
  // HRV, sleep, weight, body fat, workouts, and which apps/devices supplied
  // them). Stored per user per day (each sync overwrites that day) for the
  // Health tab; the steps also feed the daily steps log like steps-sync.
  if (req.method === "POST" && url.pathname === "/api/health/sync") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const { days, platform } = await readJsonBody(req);
    if (!Array.isArray(days)) return sendJson(res, 400, { error: "days must be an array" });
    const oldest = new Date(Date.now() - 32 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 10) / 10 : null; };
    const str = (v, max = 80) => (typeof v === "string" ? v.slice(0, max) : null);
    const all = readJson(HEALTH_FILE, {});
    if (!all[user.id]) all[user.id] = {};
    let saved = 0;
    for (const d of days.slice(0, 31)) {
      const key = String(d?.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < oldest) continue;
      all[user.id][key] = {
        steps: num(d.steps, 200000),
        distanceM: num(d.distanceM, 500000),
        activeKcal: num(d.activeKcal, 20000),
        avgHr: num(d.avgHr, 300),
        restingHr: num(d.restingHr, 300),
        hrvMs: num(d.hrvMs, 1000),
        sleepMin: num(d.sleepMin, 1440),
        weightKg: num(d.weightKg, 500),
        bodyFatPct: num(d.bodyFatPct, 100),
        workouts: (Array.isArray(d.workouts) ? d.workouts : []).slice(0, 30).map(w => ({
          type: str(w?.type, 60), start: str(w?.start, 40), end: str(w?.end, 40), kcal: num(w?.kcal, 20000),
        })),
        sources: (Array.isArray(d.sources) ? d.sources : []).slice(0, 20).map(x => str(x)).filter(Boolean),
        platform: str(platform, 20),
        syncedAt: new Date().toISOString(),
      };
      saved++;
    }
    if (saved) writeJson(HEALTH_FILE, all);
    const changed = applySyncedSteps(user.id, days.filter(d => d && d.steps != null));
    return sendJson(res, 200, { ok: true, saved, changed });
  }

  const delMatch = url.pathname.match(/^\/api\/food-log\/entries\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const id = delMatch[1];
    const all = readJson(LOG_FILE, {});
    const byDate = all[user.id] || {};
    // Delete doesn't know which day the entry is on -- scan all of this
    // user's dates rather than requiring the frontend to track/pass one.
    for (const key of Object.keys(byDate)) {
      const before = byDate[key].length;
      byDate[key] = byDate[key].filter(e => e.id !== id);
      if (byDate[key].length !== before) { writeJson(LOG_FILE, all); break; }
    }
    return sendJson(res, 200, { ok: true });
  }

  // Authorization-scoped Drive read proxy for a food-log photo's thumbnail
  // -- the fileId must belong to one of the requester's own entries.
  const mediaMatch = url.pathname.match(/^\/api\/food-log\/media\/([^/]+)$/);
  if (mediaMatch && req.method === "GET") {
    const user = resolveTargetUser(req, url);
    if (!user) { res.writeHead(401); res.end(); return true; }
    const fileId = mediaMatch[1];
    const byDate = readJson(LOG_FILE, {})[user.id] || {};
    const owns = Object.values(byDate).some(entries => entries.some(e => e.driveFileId === fileId));
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
