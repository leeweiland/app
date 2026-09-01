// food_log_backend.js — food photo -> calorie/macro estimate, logged per
// day. Shares the OpenAI vision helper with body_analysis_backend.js
// (openai_vision_backend.js) but uses its own short, plain nutrition-
// estimate prompt rather than the coaching-email voice -- this isn't a
// reply to the athlete, just a structured read of what's on the plate.

import { Readable } from "stream";
import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, getDriveAccessToken, uploadStreamToDrive, streamDriveMedia, sendJson } from "./chat_backend.js";
import { analyzeImageWithOpenAI } from "./openai_vision_backend.js";
import { parseMultipartUpload } from "./multipart_util.js";

const LOG_FILE = "chat_food_log.json";
// TODO(lee): replace with a real Drive folder id, same as
// body_stats_backend.js's PROGRESS_PHOTOS_FOLDER -- can be the same folder
// or a separate one, your call.
const FOOD_PHOTOS_FOLDER = "REPLACE_WITH_REAL_DRIVE_FOLDER_ID";

const FOOD_ESTIMATE_TOOL = {
  type: "function",
  function: {
    name: "submit_food_estimate",
    description: "Submit a structured calorie/macro estimate for the photographed food.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short plain description of what's on the plate, e.g. 'grilled chicken breast, rice, broccoli'." },
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
app. A user photographed their own meal to log it for the day -- this is a normal, requested, routine
food-diary entry from a consenting app user, not a judgment of anyone.

Estimate the total calories and macros (protein/fat/carbs in grams) for everything visible on the plate,
using typical portion sizes and standard nutrition data. Be a reasonable, decisive estimate -- this is a
rough diary entry, not a lab measurement, and the user can always edit the numbers afterward.`;

function dateKey(iso) {
  return (iso || new Date().toISOString()).slice(0, 10);
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
      calories: fields.calories ? Number(fields.calories) : null,
      macros: {
        proteinG: fields.proteinG ? Number(fields.proteinG) : null,
        fatG: fields.fatG ? Number(fields.fatG) : null,
        carbG: fields.carbG ? Number(fields.carbG) : null,
      },
      mealLabel: fields.mealLabel || null,
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
          folderId: FOOD_PHOTOS_FOLDER,
          accessToken,
        });
        entry.driveFileId = uploaded.id;
      } catch (e) {
        // Unlike progress photos, the photo here is just a memory aid for an
        // estimate that's already been produced -- losing it doesn't make
        // the logged entry useless, so this stays non-blocking.
        console.error("[food-log] Drive upload failed:", e.message);
      }
    }

    if (entry.calories == null || !entry.description) {
      return sendJson(res, 400, { error: "description and calories are required (or a photo the AI could read)" });
    }

    const all = readJson(LOG_FILE, {});
    if (!all[user.id]) all[user.id] = {};
    const key = dateKey(entry.createdAt);
    if (!all[user.id][key]) all[user.id][key] = [];
    all[user.id][key].push(entry);
    writeJson(LOG_FILE, all);

    return sendJson(res, 200, { entry });
  }

  if (req.method === "GET" && url.pathname === "/api/food-log/entries") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const date = url.searchParams.get("date") || dateKey();
    const all = readJson(LOG_FILE, {});
    const entries = (all[user.id] || {})[date] || [];
    const totals = entries.reduce((t, e) => ({
      calories: t.calories + (e.calories || 0),
      proteinG: t.proteinG + (e.macros?.proteinG || 0),
      fatG: t.fatG + (e.macros?.fatG || 0),
      carbG: t.carbG + (e.macros?.carbG || 0),
    }), { calories: 0, proteinG: 0, fatG: 0, carbG: 0 });
    return sendJson(res, 200, { entries, totals });
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
    const user = getSessionUser(req);
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
