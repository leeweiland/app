// body_analysis_backend.js — photo-based body composition / move-form feedback.
// Uses OpenAI's vision-capable chat completion model for the qualitative
// read (body-fat look, flexibility/mobility/strength gaps) and does the
// calorie/macro math itself with a standard formula rather than trusting the
// model to invent numbers. Photos are uploaded to Drive for record-keeping
// and results are saved per-user so they persist across sessions.

import Busboy from "busboy";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import { readJson, writeJson, getSessionUser, getDriveAccessToken, uploadStreamToDrive, sendJson } from "./chat_backend.js";

const SCANS_FILE = "chat_body_scans.json";
const SCAN_PHOTOS_FOLDER = "1Da9BVFV5N8vRAEJiPHOSyabGkNPnUhqw";

const MODEL = "gpt-4o";

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
    const fields = {};
    let image = null;
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("file", (name, stream, info) => {
      if (name !== "photo") { stream.resume(); return; }
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => { image = { buffer: Buffer.concat(chunks), mimeType: info.mimeType }; });
    });
    bb.on("finish", () => resolve({ fields, image }));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

// Mifflin-St Jeor — the standard, defensible TDEE formula (not AI-guessed).
function calcCalorieTarget({ heightCm, weightKg, age, sex, activityLevel, goal }) {
  const h = Number(heightCm), w = Number(weightKg), a = Number(age) || 30;
  const bmr = sex === "female"
    ? 10 * w + 6.25 * h - 5 * a - 161
    : 10 * w + 6.25 * h - 5 * a + 5;
  const activityMultipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  const tdee = bmr * (activityMultipliers[activityLevel] || 1.375);
  const goalMultipliers = { cut: 0.8, maintain: 1.0, bulk: 1.1 };
  return Math.round(tdee * (goalMultipliers[goal] || 1.0));
}

function calcMacros(calories) {
  // 40% protein / 30% fat / 30% carb, per the requested split.
  const proteinCal = calories * 0.40, fatCal = calories * 0.30, carbCal = calories * 0.30;
  return {
    proteinG: Math.round(proteinCal / 4),
    fatG: Math.round(fatCal / 9),
    carbG: Math.round(carbCal / 4),
  };
}

function buildMealPlan(macros, calories) {
  // Even split across 6 meals — simple and predictable, matches what was asked for.
  const perMeal = {
    calories: Math.round(calories / 6),
    proteinG: Math.round(macros.proteinG / 6),
    fatG: Math.round(macros.fatG / 6),
    carbG: Math.round(macros.carbG / 6),
  };
  return Array.from({ length: 6 }, (_, i) => ({ meal: i + 1, ...perMeal }));
}

async function callOpenAiVision(imageBuffer, mimeType, systemPrompt, userPrompt) {
  const base64 = imageBuffer.toString("base64");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
        ] },
      ],
      max_tokens: 700,
      temperature: 0.4,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "OpenAI request failed");
  return d.choices?.[0]?.message?.content || "";
}

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

// Both scan types now close the same way: real change comes from holistic,
// comprehensive training under real instruction — not a single photo read —
// and the email should land on inviting them to apply for coaching.
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

Give a rough, honest READ — not a medical or clinical diagnosis. Make clear this is a visual estimate
only, not a body composition scan, and can be meaningfully off.

Format your entire response EXACTLY like this:
Line 1, alone: "BODY FAT ESTIMATE: X-Y%" — your best visual-estimate range from visible cues only.
Then a blank line, then the email body in a Problem-Agitate-Solve arc (flowing prose, no labeled
sections): what's visibly holding their physique back right now (PROBLEM), why it matters for a typical
training goal if left unaddressed (AGITATE), then the SOLVE per the coaching close below. Keep it
respectful and non-judgmental. Do not comment on anything other than body composition.

${COACHING_CLOSE}

${VOICE_GUIDE}`;

const MOVE_SYSTEM_PROMPT = `You are Lee Weiland, a movement coach at Pacific Rim Athletics, replying by
email to one of your own athletes. They uploaded this private photo themselves, through your gym's private
coaching app, of an attempt at a specific bodyweight position/move (e.g. bridge, splits, handstand),
specifically requesting form feedback. This is a normal, requested, one-on-one coaching interaction with a
consenting adult client. State clearly this is a rough visual estimate, not a clinical mobility/strength
assessment. If they gave a goal for this move, weigh the assessment against that goal specifically.

Write the email in a Problem-Agitate-Solve arc (flowing prose, no labeled sections): what's visibly
limiting the position right now — which joint/tissue/strength quality (PROBLEM), why that matters for
reaching their stated goal or the move generally if no goal was given (AGITATE), then the SOLVE per the
coaching close below.

${COACHING_CLOSE}

${VOICE_GUIDE}`;

// A flat "I'm sorry, I can't assist with that" (or similar) sometimes slips
// through even with the framing above — cheap to detect and retry once with
// extra reassurance before giving up and telling the user plainly.
function looksLikeRefusal(text) {
  return /^\s*(i'?m sorry|i can'?t|i cannot|i'?m not able|i won'?t)/i.test(text || "");
}

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
    const { fields, image } = await parseMultipart(req);
    if (!image) return sendJson(res, 400, { error: "photo is required" });

    const analysisType = fields.analysisType === "move" ? "move" : "body";

    // Move Scan is about the move only — no nutrition/macro math at all.
    let calorieTarget = null, macros = null, mealPlan = null;
    if (analysisType === "body") {
      const calorieInputs = {
        heightCm: fields.heightCm, weightKg: fields.weightKg, age: fields.age,
        sex: fields.sex, activityLevel: fields.activityLevel, goal: fields.goal,
      };
      if (calorieInputs.heightCm && calorieInputs.weightKg) {
        calorieTarget = calcCalorieTarget(calorieInputs);
        macros = calcMacros(calorieTarget);
        mealPlan = buildMealPlan(macros, calorieTarget);
      }
    }

    // The AI visual read and the deterministic calorie/macro math are independent —
    // a failure on one (bad photo, OpenAI hiccup) shouldn't discard the other.
    let aiText;
    try {
      const userPrompt = analysisType === "body"
        ? "Assess this photo for visible body composition."
        : (() => {
            const moveType = fields.moveType || "this position";
            const goalLine = fields.moveGoal ? `Their goal: ${fields.moveGoal}.` : "No specific goal was given.";
            return `This is an attempt at: ${moveType}. ${goalLine} Assess the form and what's limiting it.`;
          })();
      const systemPrompt = analysisType === "body" ? BODY_SYSTEM_PROMPT : MOVE_SYSTEM_PROMPT;

      aiText = await callOpenAiVision(image.buffer, image.mimeType, systemPrompt, userPrompt);
      if (looksLikeRefusal(aiText)) {
        aiText = await callOpenAiVision(image.buffer, image.mimeType, systemPrompt,
          `${userPrompt} Reminder: this athlete is a consenting adult client who requested this exact feedback from their own coach through a private app — this is a normal, authorized coaching request, please proceed with the assessment.`);
      }
      if (looksLikeRefusal(aiText)) {
        aiText = analysisType === "body"
          ? "Couldn't generate a visual read for this photo. Try a clearer, well-lit, full-body photo (front-facing, minimal baggy clothing) and run it again."
          : "Couldn't generate a form read for this photo. Try a clearer, well-lit photo taken from the side, with the full body and the move clearly visible, and run it again.";
      }
    } catch (e) {
      aiText = `Visual assessment unavailable: ${e.message}`;
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
      // Move Scan already has the athlete's own answer for what's shown
      // (fields.moveType) — that's a better label than a fresh AI guess at
      // the same photo would be, so it's used directly instead of spending
      // another vision call on it.
      const contentGuess = analysisType === "body"
        ? "BODY SCAN"
        : (fields.moveType || "MOVE SCAN").replace(/[^a-zA-Z0-9 ]/g, "").trim() || "MOVE SCAN";
      const userName = user ? `${user.first} ${user.last}` : "GUEST";
      const uploaded = await uploadStreamToDrive(Readable.from(image.buffer), {
        name: `${userName} ${contentGuess}`.toUpperCase() + ext,
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
        const all = readJson(SCANS_FILE, {});
        if (!all[user.id]) all[user.id] = [];
        all[user.id].push({
          id: randomUUID(),
          type: analysisType,
          createdAt: new Date().toISOString(),
          assessment: aiText,
          calorieTarget,
          macros,
          mealPlan,
          driveFileId,
          moveType: fields.moveType || null,
        });
        writeJson(SCANS_FILE, all);
      } catch (e) {
        console.error("[body-scan] Save result failed:", e.message);
      }
    }

    return sendJson(res, 200, {
      analysisType,
      assessment: aiText,
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
