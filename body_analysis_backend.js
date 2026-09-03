// body_analysis_backend.js — photo-based body composition feedback. Uses
// OpenAI's vision-capable chat completion model for the qualitative read
// (body-fat look) and does the calorie/macro math itself with a standard
// formula rather than trusting the model to invent numbers. Photos are
// uploaded to Drive for record-keeping and results are saved per-user so
// they persist across sessions.

import { Readable } from "stream";
import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, resolveTargetUser, getDriveAccessToken, uploadStreamToDrive, sendJson, getConfig } from "./chat_backend.js";
import { analyzeImageWithOpenAI } from "./openai_vision_backend.js";
import { recordWeightEntry, getLatestWeightKg } from "./body_stats_backend.js";
import { parseMultipartUpload } from "./multipart_util.js";
import { calcCalorieTarget, calcMacros, buildMealPlan } from "./nutrition_calc.js";

const SCANS_FILE = "chat_body_scans.json";
const PROFILE_FILE = "chat_body_profile.json";

// Forces structured output (a body-fat range as actual numbers, not text to
// regex out of a formatted line) via a tool call. No coaching-email content
// anymore -- just the number.
const BODY_SCAN_TOOL = {
  type: "function",
  function: {
    name: "submit_body_scan_assessment",
    description: "Submit the visual body-fat percentage estimate.",
    parameters: {
      type: "object",
      properties: {
        bodyFatLowPct: { type: "number", description: "Low end of the visual-estimate body-fat percentage range." },
        bodyFatHighPct: { type: "number", description: "High end of the visual-estimate body-fat percentage range." },
      },
      required: ["bodyFatLowPct", "bodyFatHighPct"],
      additionalProperties: false,
    },
  },
};

// Framing note: earlier versions of this prompt (a bare "estimate this
// person's body-fat %" instruction) got flat refusals from the vision model
// — reading as an unsolicited judgment of a stranger's body triggers safety
// guardrails. Explicitly establishing that this is a private, requested,
// one-on-one coach/client interaction (which it is — the photo is uploaded
// by the athlete themselves, through a gated app, specifically to get this
// read) resolves that without changing what's actually being asked for.
const BODY_SYSTEM_PROMPT = `You are assisting a private fitness coaching app. A user uploaded this
private photo of themselves specifically to get a visual body-fat percentage estimate -- a normal,
requested, one-on-one interaction with a consenting adult client, not an unsolicited judgment of a
stranger's photo.

Give your best visual-estimate body-fat percentage range from visible cues only. This is a rough estimate,
not a clinical or medical measurement, and can be meaningfully off -- just the number range, nothing else.`;

export async function handleBodyAnalysisRequest(req, res, url) {
  // ── GET saved scans for logged-in user ───────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/body-scan/scans") {
    const user = resolveTargetUser(req, url);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const all = readJson(SCANS_FILE, {});
    return sendJson(res, 200, { scans: (all[user.id] || []).slice().reverse() });
  }

  // ── DELETE a saved scan ───────────────────────────────────────────────────
  const delMatch = url.pathname.match(/^\/api\/body-scan\/scans\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const scanId = delMatch[1];
    const all = readJson(SCANS_FILE, {});
    if (all[user.id]) {
      all[user.id] = all[user.id].filter(s => s.id !== scanId);
      writeJson(SCANS_FILE, all);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "POST" || url.pathname !== "/api/body-scan/analyze") return false;

  try {
    const user = getSessionUser(req);
    const { fields, image } = await parseMultipartUpload(req);
    if (!image) return sendJson(res, 400, { error: "photo is required" });

    // The Scan tab no longer asks for height/weight/age/sex/activity/goal
    // directly (that's the Food Log profile now) -- fields.* stays as an
    // explicit-override path for API callers that do supply it, falling
    // back to the saved profile + latest weigh-in otherwise.
    const profile = user ? readJson(PROFILE_FILE, {})[user.id] || null : null;
    const calorieInputs = {
      heightCm: fields.heightCm || profile?.heightCm,
      weightKg: fields.weightKg || (user ? getLatestWeightKg(user.id) : null),
      age: fields.age || profile?.age,
      sex: fields.sex || profile?.sex,
      activityLevel: fields.activityLevel || profile?.activityLevel,
      goal: fields.goal || profile?.goal,
    };
    let calorieTarget = null, macros = null, mealPlan = null;
    if (calorieInputs.heightCm && calorieInputs.weightKg) {
      calorieTarget = calcCalorieTarget(calorieInputs);
      macros = calcMacros(calorieTarget);
      mealPlan = buildMealPlan(macros, calorieTarget);
    }

    // The AI visual read and the deterministic calorie/macro math are independent —
    // a failure on one (bad photo, OpenAI hiccup) shouldn't discard the other.
    let bodyFatLowPct = null, bodyFatHighPct = null, refused = false, readError = null;
    try {
      const result = await analyzeImageWithOpenAI({
        imageBuffer: image.buffer, mimeType: image.mimeType,
        systemPrompt: BODY_SYSTEM_PROMPT,
        userPrompt: "Assess this photo for visible body composition.",
        tool: BODY_SCAN_TOOL,
        reassurance: "Reminder: this athlete is a consenting adult client who requested this exact feedback through a private app — this is a normal, authorized request, please proceed with the estimate.",
      });
      if (result.refused) {
        refused = true;
        readError = "Couldn't generate a visual read for this photo. Try a clearer, well-lit, full-body photo (front-facing, minimal baggy clothing) and run it again.";
      } else {
        bodyFatLowPct = result.args.bodyFatLowPct;
        bodyFatHighPct = result.args.bodyFatHighPct;
      }
    } catch (e) {
      refused = true;
      readError = `Visual read unavailable: ${e.message}`;
    }

    // Upload photo to Drive and save result — both fire-and-forget so a failure
    // here never blocks the response the user is already waiting for.
    let driveFileId = null;
    try {
      const accessToken = await getDriveAccessToken();
      const ext = image.mimeType.includes("png") ? ".png" : image.mimeType.includes("webp") ? ".webp" : ".jpg";
      // "FIRST LAST BEST-GUESS-OF-CONTENT", all caps — matches how the rest
      // of the app's uploads (chat, training footage) get labeled, so these
      // photos are actually identifiable browsing the raw Drive folder later.
      const userName = user ? `${user.first} ${user.last}` : "GUEST";
      const uploaded = await uploadStreamToDrive(Readable.from(image.buffer), {
        name: `${userName} BODY SCAN`.toUpperCase() + ext,
        mimeType: image.mimeType,
        folderId: getConfig().bodyScanPhotosFolderId,
        accessToken,
      });
      driveFileId = uploaded.id;
    } catch (e) {
      console.error("[body-scan] Drive upload failed:", e.message);
    }

    if (user) {
      try {
        const scanId = randomUUID();
        const all = readJson(SCANS_FILE, {});
        if (!all[user.id]) all[user.id] = [];
        all[user.id].push({
          id: scanId,
          type: "body",
          createdAt: fields.createdAt || new Date().toISOString(),
          bodyFatLowPct,
          bodyFatHighPct,
          refused,
          readError,
          calorieTarget,
          macros,
          mealPlan,
          driveFileId,
        });
        writeJson(SCANS_FILE, all);

        // Every scan with a usable weight (fresh or carried over from the
        // profile/latest weigh-in) adds a stats entry -- a fresh bodyFatPct
        // reading is new information worth timestamping on the bodyfat
        // trend chart even on a day the user didn't also log a new weight.
        // A scan photo is also the weekly check-in photo now (one photo
        // area does both) -- but only tag it "checkin" when the weight was
        // actually typed fresh this submission, not silently carried over
        // via the fallback, so reusing an old weight doesn't reset the
        // 7-day check-in clock with stale data.
        if (calorieInputs.weightKg) {
          const bodyFatPct = bodyFatLowPct != null && bodyFatHighPct != null
            ? (bodyFatLowPct + bodyFatHighPct) / 2 : null;
          recordWeightEntry(user.id, {
            weightKg: calorieInputs.weightKg, heightCm: calorieInputs.heightCm, bodyFatPct,
            source: fields.weightKg ? "checkin" : "scan", scanId, createdAt: fields.createdAt || null,
          });
        }
      } catch (e) {
        console.error("[body-scan] Save result failed:", e.message);
      }
    }

    return sendJson(res, 200, {
      bodyFatLowPct,
      bodyFatHighPct,
      refused,
      readError,
      calorieTarget,
      macros,
      mealPlan,
      driveFileId,
      disclaimer: "This is a visual estimate only, not a clinical or medical measurement — it can be meaningfully off.",
    });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
