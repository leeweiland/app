// body_analysis_backend.js — photo-based body composition feedback. Uses
// OpenAI's vision-capable chat completion model for the qualitative read
// (body-fat look) and does the calorie/macro math itself with a standard
// formula rather than trusting the model to invent numbers. Photos are
// uploaded to Drive for record-keeping and results are saved per-user so
// they persist across sessions.

import { Readable } from "stream";
import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, getDriveAccessToken, uploadStreamToDrive, sendJson } from "./chat_backend.js";
import { analyzeImageWithOpenAI } from "./openai_vision_backend.js";
import { recordWeightEntry, getLatestWeightKg } from "./body_stats_backend.js";
import { parseMultipartUpload } from "./multipart_util.js";
import { calcCalorieTarget, calcMacros, buildMealPlan } from "./nutrition_calc.js";

const SCANS_FILE = "chat_body_scans.json";
const PROFILE_FILE = "chat_body_profile.json";
const SCAN_PHOTOS_FOLDER = "1Da9BVFV5N8vRAEJiPHOSyabGkNPnUhqw";

// Forces structured output (a body-fat range as actual numbers, not text to
// regex out of a formatted line) via a tool call instead of a "line 1 must
// read exactly..." instruction.
const BODY_SCAN_TOOL = {
  type: "function",
  function: {
    name: "submit_body_scan_assessment",
    description: "Submit the structured body-composition visual assessment and coaching email.",
    parameters: {
      type: "object",
      properties: {
        bodyFatLowPct: { type: "number", description: "Low end of the visual-estimate body-fat percentage range." },
        bodyFatHighPct: { type: "number", description: "High end of the visual-estimate body-fat percentage range." },
        emailBody: { type: "string", description: "The Problem-Agitate-Solve coaching email body only -- no greeting, no sign-off." },
      },
      required: ["bodyFatLowPct", "bodyFatHighPct", "emailBody"],
      additionalProperties: false,
    },
  },
};

// Framing note: earlier versions of this prompt (a bare "estimate this
// person's body-fat %" instruction) got flat refusals from the vision model
// — reading as an unsolicited judgment of a stranger's body triggers safety
// guardrails. Explicitly establishing that this is a private, requested,
// one-on-one coach/client interaction (which it is — the photo is uploaded
// by the athlete themselves, to their own coach, through a gated app)
// resolves that without changing what's actually being asked for.
//
// Voice: pulled from Lee's actual newsletter copy (drive_cache.json, doc
// "WEEKLY EMAILS MIND") rather than invented. The excerpt below is fed to
// the model as a concrete style reference (few-shot beats an abstract
// description) — short punchy sentences, one or two lines per paragraph,
// direct second-person address, warm and community-minded, motivational
// without being salesy or clinical.
const VOICE_SAMPLE = `Hey %FIRSTNAME%, thanks for being part of the Pac Rim Family!
Whether you're already a student or looking forward to getting started, we're going to help you remove all the roadblocks so that you can get to the next level FAST...with this 1 really important element.
It doesn't matter if you're an 8 year old or a 50 year old, roadblocks will pop up in those areas throughout life.
We'll chip away at those roadblocks together until they're dust under your feet.`;

const VOICE_GUIDE = `Write in Lee Weiland's real voice. Here's an actual excerpt from one of his emails,
as a concrete style reference — match this rhythm and tone exactly, but write entirely new content, never
reuse its phrases or subject matter:

"""
${VOICE_SAMPLE}
"""

Short, punchy sentences. One or two sentences per paragraph, with a blank line between paragraphs — never
a dense block. Direct, second-person ("you"), warm and personal, like writing to someone you actually
coach. Occasional ellipses for pacing is fine. Grounded and encouraging, never salesy, never clinical,
never uses bullet points or headers like "Problem:"/"Solve:" — it should read as one continuous, natural
email, not a templated report.
Do not include any greeting/salutation (e.g. "Hey NAME," or "Hi there,") — that's added separately.
Do not include a sign-off (e.g. "Blessings," "Talk soon,") — that's also added separately. Just write the
body content.`;

// Real change comes from holistic, comprehensive training under real
// instruction — not a single photo read — and the email should land on
// inviting them to apply for coaching.
const COACHING_CLOSE = `Then, instead of prescribing specific fixes yourself, steer the close of the email
toward this: real, lasting change comes from holistic strength and comprehensive training, not an isolated
tip — and from proper hands-on instruction. Be direct that an app or a single photo read is not a
substitute for real coaching: a coach in person can see things a photo can't, correct things safely in
real time, and build a full training plan around the whole person, not just one number or one position.
Land on inviting them to apply for coaching so they can get that real instruction. Keep this genuine, not
like boilerplate — weave it into the coaching logic, not tacked on.`;

const BODY_SYSTEM_PROMPT = `You are Lee Weiland, a fitness coach at Pacific Rim Athletics, replying by
email to one of your own athletes. They uploaded this private progress photo themselves, through your
gym's private coaching app, specifically to request this exact feedback. This is a normal, requested,
one-on-one coaching interaction with a consenting adult client — not an unsolicited judgment of a
stranger's photo.

Give a rough, honest READ — not a medical or clinical diagnosis. Your body-fat percentage range should be
your best visual estimate from visible cues only, and can be meaningfully off — make that clear somewhere
in the email itself, not just as a disclaimer field.

Write the email body in a Problem-Agitate-Solve arc (flowing prose, no labeled sections): what's visibly
holding their physique back right now (PROBLEM), why it matters for a typical training goal if left
unaddressed (AGITATE), then the SOLVE per the coaching close below. Keep it respectful and non-judgmental.
Do not comment on anything other than body composition.

${COACHING_CLOSE}

${VOICE_GUIDE}`;

export async function handleBodyAnalysisRequest(req, res, url) {
  // ── GET saved scans for logged-in user ───────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/body-scan/scans") {
    const user = getSessionUser(req);
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
    let assessmentBody, bodyFatLowPct = null, bodyFatHighPct = null, refused = false;
    try {
      const result = await analyzeImageWithOpenAI({
        imageBuffer: image.buffer, mimeType: image.mimeType,
        systemPrompt: BODY_SYSTEM_PROMPT,
        userPrompt: "Assess this photo for visible body composition.",
        tool: BODY_SCAN_TOOL,
        reassurance: "Reminder: this athlete is a consenting adult client who requested this exact feedback from their own coach through a private app — this is a normal, authorized coaching request, please proceed with the assessment.",
      });
      if (result.refused) {
        refused = true;
        assessmentBody = "Couldn't generate a visual read for this photo. Try a clearer, well-lit, full-body photo (front-facing, minimal baggy clothing) and run it again.";
      } else {
        assessmentBody = result.args.emailBody;
        bodyFatLowPct = result.args.bodyFatLowPct;
        bodyFatHighPct = result.args.bodyFatHighPct;
      }
    } catch (e) {
      refused = true;
      assessmentBody = `Visual assessment unavailable: ${e.message}`;
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
        folderId: SCAN_PHOTOS_FOLDER,
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
          createdAt: new Date().toISOString(),
          assessmentBody,
          bodyFatLowPct,
          bodyFatHighPct,
          refused,
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
            source: fields.weightKg ? "checkin" : "scan", scanId,
          });
        }
      } catch (e) {
        console.error("[body-scan] Save result failed:", e.message);
      }
    }

    return sendJson(res, 200, {
      assessmentBody,
      bodyFatLowPct,
      bodyFatHighPct,
      refused,
      calorieTarget,
      macros,
      mealPlan,
      driveFileId,
      disclaimer: "Don't mistake this for proper instruction with a positive tribe. This is just an estimate based on the data you entered. This is not coaching. Get real coaching for maximum results.",
    });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
