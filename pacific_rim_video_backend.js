// pacific_rim_video_backend.js — a second brand riding the same pipeline as
// social_video_backend.js (vertical reframe -> AI caption -> schedule to
// Metricool), publishing to the "Pacific Rim Athletics" brand/blog in
// Metricool instead of Powerbatics. Triggered by the Gym Capture flow
// (chat_backend.js's /api/chat/gym-capture) rather than the favorite-star —
// the clip is already trimmed and permanently saved to Drive by the time
// this runs, so unlike social_video_backend.js's save-and-publish there's no
// trim/save step here, just reframe -> caption -> schedule.

import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID, createHash } from "crypto";
import { execFileSync } from "child_process";
import ffmpegPath from "ffmpeg-static";
import {
  readJson, writeJson, getSessionUser, isStaff, readJsonBody, sendJson, getDriveAccessToken,
} from "./chat_backend.js";
import {
  CAPTION_PLATFORMS, ownWordsRuleFor, generateCaptionsFromContext, semanticRetrieve,
  reframeVideoVertical, makeDriveFilePublic, metricoolAuth, getConnectedAccounts,
  findNextOpenDay, buildMetricoolPostBody, schedulePost, uploadThumbnailToMetricool,
  NETWORK_TYPE_MAP,
} from "./social_video_backend.js";

const SETTINGS_FILE = "pacific_rim_video_settings.json"; // DATA_DIR — admin-editable
const DEFAULT_SETTINGS = {
  aiPrompt: "", ownWordsRatio: 60,
  // Every network this pipeline is capable of publishing to -- an admin can
  // switch any of them off without touching which Metricool accounts are
  // actually connected (that part still auto-detects via getConnectedAccounts).
  platforms: { fb: true, fbs: true, ig: true, igs: true, li: true, tt: true, x: true, yt: true },
  postHour: 3, // wall-clock hour in America/Anchorage -- see buildMetricoolPostBody's dateTimeStr
};

function getSettings() {
  const saved = readJson(SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...saved, platforms: { ...DEFAULT_SETTINGS.platforms, ...(saved.platforms || {}) } };
}

async function generateCaptions({ description }) {
  const settings = getSettings();
  const brandPrompt = settings.aiPrompt || "Write bold, direct, no-fluff training-focused social captions.";
  let chunks = [];
  try { chunks = await semanticRetrieve(description || "training video caption", { topN: 20 }); }
  catch (e) { console.error("[pacific-rim generateCaptions] semanticRetrieve failed, continuing without voice bank:", e.message); }
  const voiceBlock = chunks.length
    ? chunks.map(c => `--- ${c.type === "campaign" ? "EMAIL" : "DOC"}: ${c.source} ---\n${c.text}`).join("\n\n")
    : "(no voice-bank matches found — write fresh copy in the brand voice below)";
  const sharedContext = `BRAND VOICE INSTRUCTIONS:\n${brandPrompt}\n\n${ownWordsRuleFor(settings.ownWordsRatio)}\n\nVOICE BANK (real past writing to draw from):\n${voiceBlock}\n\n${description ? `WHAT'S IN THIS CLIP: ${description}\n\n` : ""}This caption is for the Pacific Rim Athletics brand.`;
  return generateCaptionsFromContext(sharedContext);
}

// ffmpeg-static ships only the ffmpeg binary, no ffprobe -- `ffmpeg -i` with
// no output file always exits non-zero, but still prints the stream info
// (including resolution) to stderr on its way out, which is all
// reframeVideoVertical actually needs.
function probeVideoDimensions(path) {
  try {
    execFileSync(ffmpegPath, ["-i", path], { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
  } catch (e) {
    const stderr = e.stderr?.toString() || "";
    const m = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return { width: 1920, height: 1080 }; // safe horizontal-video fallback
}

// The core publish step, called directly (in-process, no HTTP round trip)
// from chat_backend.js's gym-capture handler once its own Drive upload has
// already succeeded -- driveFileId here is that ALREADY-TRIMMED, ALREADY-
// PERMANENTLY-SAVED clip, so unlike social_video_backend.js's save-and-
// publish there's no trim or "save a copy" step: just reframe, caption,
// schedule. Never throws -- always resolves with a result object, since
// callers treat this as best-effort background work.
export async function publishPacificRimClip({ driveFileId, label, thumbnailBase64, thumbnailTimeSec }) {
  if (!driveFileId) return { published: false, error: "driveFileId required" };
  const settings = getSettings();
  let auth;
  try {
    auth = metricoolAuth(process.env.METRICOOL_PRA_BLOG_ID);
  } catch (e) {
    return { published: false, error: e.message };
  }

  const ts = randomUUID();
  const tmpIn = join(tmpdir(), `pra_in_${ts}.mp4`);
  const tmpVertical = join(tmpdir(), `pra_vert_${ts}.mp4`);
  let tempVerticalFileId = null;
  const result = { published: false };

  try {
    const accessToken = await getDriveAccessToken();
    const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!dlRes.ok) throw new Error(`Drive download failed: ${dlRes.status}`);
    writeFileSync(tmpIn, Buffer.from(await dlRes.arrayBuffer()));

    const { width, height } = probeVideoDimensions(tmpIn);
    reframeVideoVertical(tmpIn, tmpVertical, { videoWidth: width, videoHeight: height, startTime: 0 });

    const { uploadStreamToDrive } = await import("./chat_backend.js");
    const { createReadStream } = await import("fs");
    const cfg = readJson("chat_admin_config.json", {});
    const vertResult = await uploadStreamToDrive(createReadStream(tmpVertical), {
      name: `PACIFIC RIM ATHLETICS VERTICAL ${Date.now()}.mp4`,
      mimeType: "video/mp4",
      folderId: cfg.gymTrainingFolderId || cfg.favoritesFolderId,
      accessToken,
    });
    tempVerticalFileId = vertResult.id;
    const publicMediaUrl = await makeDriveFilePublic(tempVerticalFileId, accessToken);

    const captions = await generateCaptions({ description: label || "" });
    const accounts = await getConnectedAccounts(auth);

    let thumbnailUrl = null;
    if (thumbnailBase64) {
      try { thumbnailUrl = await uploadThumbnailToMetricool(auth, thumbnailBase64); }
      catch (e) { console.error("[publishPacificRimClip] thumbnail upload failed, publishing without a custom one:", e.message); }
    }
    const coverMilliseconds = Number.isFinite(thumbnailTimeSec) ? thumbnailTimeSec * 1000 : undefined;

    const networkToPlatform = { facebook: "fb", instagram: "ig", youtube: "yt", tiktok: "tt", linkedin: "li", twitter: "x" };
    const storyPlatform = { facebook: "fbs", instagram: "igs" };
    // Connected AND admin-enabled -- a brand-new network showing up connected
    // in Metricool doesn't start posting until an admin explicitly turns it
    // on here, same reasoning as any other new-capability-off-by-default gate.
    const platformIds = Object.entries(accounts)
      .filter(([, id]) => !!id)
      .flatMap(([net]) => [networkToPlatform[net], storyPlatform[net]].filter(Boolean))
      .filter(id => settings.platforms[id]);

    const day = await findNextOpenDay(auth, {});
    if (!day) throw new Error("Could not find an open day to schedule on");
    const hour = String(Math.max(0, Math.min(23, Number(settings.postHour) || 0))).padStart(2, "0");
    const dateTimeStr = `${day}T${hour}:00:00`;

    const results = [];
    for (const platformId of platformIds) {
      const accountId = accounts[NETWORK_TYPE_MAP[platformId]];
      const captionKey = platformId === "fbs" ? "fb" : platformId === "igs" ? "ig" : platformId;
      const plat = captions[captionKey] || {};
      const postBody = buildMetricoolPostBody({ platformId, accountId, text: plat.desc, title: plat.title, mediaUrl: publicMediaUrl, dateTimeStr, thumbnailUrl, coverMilliseconds });
      try {
        await schedulePost(auth, postBody);
        results.push({ platformId, ok: true });
      } catch (e) {
        results.push({ platformId, ok: false, error: e.message });
      }
    }
    result.published = true;
    result.scheduledDay = day;
    result.results = results;
  } catch (e) {
    result.error = e.message;
    console.error("[publishPacificRimClip] failed:", e.stack || e);
  } finally {
    [tmpIn, tmpVertical].forEach(f => { try { unlinkSync(f); } catch {} });
    if (tempVerticalFileId) {
      try {
        const delToken = await getDriveAccessToken();
        await fetch(`https://www.googleapis.com/drive/v3/files/${tempVerticalFileId}`, { method: "DELETE", headers: { Authorization: `Bearer ${delToken}` } });
      } catch (e) { console.error("[publishPacificRimClip] couldn't discard temp vertical file:", e.message); }
    }
  }
  return result;
}

export async function handlePacificRimVideoRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/pacific-rim-video/")) return false;

  const user = getSessionUser(req);
  if (!user || !isStaff(user)) { sendJson(res, 403, { error: "Staff only" }); return true; }

  if (p === "/api/pacific-rim-video/settings") {
    if (req.method === "GET") {
      const settings = getSettings();
      sendJson(res, 200, {
        ...settings,
        metricoolConfigured: !!(process.env.METRICOOL_API_KEY && process.env.METRICOOL_USER_ID && process.env.METRICOOL_PRA_BLOG_ID),
        anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
        openaiConfigured: !!process.env.OPENAI_API_KEY,
      });
      return true;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const current = getSettings();
      if (body.aiPrompt !== undefined) current.aiPrompt = String(body.aiPrompt).slice(0, 8000);
      if (body.ownWordsRatio !== undefined) current.ownWordsRatio = Math.max(0, Math.min(100, Number(body.ownWordsRatio) || 0));
      if (body.postHour !== undefined) current.postHour = Math.max(0, Math.min(23, Number(body.postHour) || 0));
      if (body.platforms && typeof body.platforms === "object") {
        Object.keys(DEFAULT_SETTINGS.platforms).forEach(k => {
          if (body.platforms[k] !== undefined) current.platforms[k] = !!body.platforms[k];
        });
      }
      writeJson(SETTINGS_FILE, current);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}
