// favorites_montage_backend.js — builds a horizontal 16:9 highlight-reel
// video from a student's coach-favorited photos/videos, shown at the top of
// that student's Physique Builder Reports tab. Reuses the same Drive-
// download/ffmpeg conventions as social_video_backend.js's vertical reframe
// (execFileSync + ffmpeg-static), just horizontal (letterboxed 16:9) and
// drawing from chat_favorites.json instead of one fresh upload.
//
// Once built, a student's montage sticks (chat_body_montages.json caches
// which Drive file is "the" montage for them) instead of rebuilding on
// every Reports page load -- a fresh one is only ever built again when the
// student explicitly hits Regenerate. Each regeneration uploads a NEW file
// to the assigned Drive folder (the old one is left alone, not deleted) and
// the cache record is repointed at it.

import { writeFileSync, unlinkSync, createReadStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import ffmpegPath from "ffmpeg-static";
import {
  readJson, writeJson, getSessionUser, resolveTargetUser, getDriveAccessToken, uploadStreamToDrive, sendJson, streamDriveMedia, isClientRole,
} from "./chat_backend.js";

const FAVORITES_FILE = "chat_favorites.json";
const CONVOS_FILE = "chat_conversations.json";
const MONTAGES_FILE = "chat_body_montages.json"; // { [userId]: { driveFileId, createdAt, clipCount } }

const OUT_W = 1920, OUT_H = 1080;
const IMAGE_CLIP_SECONDS = 3.5;
const MAX_VIDEO_CLIP_SECONDS = 6;
const MAX_CLIPS = 10; // keeps montage length/compute bounded

// A coach's favorite is tagged with the source conversationId, not with
// "who this is a highlight of" -- there's no such field. First cut of this
// scoped "conversation I'm part of" to ANY participant, which broke the
// first time a coach checked their OWN Reports: a coach/admin is a
// participant in every one of their students' DMs (they're the one doing
// the favoriting), so that pulled every student's favorited clips into the
// coach's own personal montage right along with the student's.
// Client-role only, DM-only fixes it: a client only ever has their own 1:1
// coaching DM(s), so "conversations I'm in" is actually scoped to them —
// staff get an empty montage instead of a leak. A group conversation is
// left out entirely too, same reasoning (ambiguous whose highlight it is
// with more than one client in the room).
function favoritesForUser(user) {
  if (!isClientRole(user.role)) return [];
  const convos = readJson(CONVOS_FILE, []);
  const myDmIds = new Set(convos.filter(c => c.type === "dm" && c.participantIds.includes(user.id)).map(c => c.id));
  const all = readJson(FAVORITES_FILE, []);
  return all.filter(f => f.conversationId && myDmIds.has(f.conversationId) && f.driveFileId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

async function downloadDriveFile(fileId, accessToken, destPath) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Drive download failed for ${fileId}: ${r.status}`);
  writeFileSync(destPath, Buffer.from(await r.arrayBuffer()));
}

// Normalizes one favorite (image or video) into a uniform 1920x1080/30fps/
// AAC segment so the final concat pass (which requires matching codecs and
// resolution) just works. Letterboxes (scale+pad) rather than crops, so a
// vertical/portrait phone clip never loses its subject off the edges the
// way a crop-to-fill would.
function normalizeSegment(inputPath, outputPath, { isImage }) {
  const vf = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
  if (isImage) {
    execFileSync(ffmpegPath, [
      "-y", "-loop", "1", "-i", inputPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-t", String(IMAGE_CLIP_SECONDS),
      "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      outputPath,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });
  } else {
    execFileSync(ffmpegPath, [
      "-y", "-i", inputPath, "-t", String(MAX_VIDEO_CLIP_SECONDS),
      "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-movflags", "+faststart",
      outputPath,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });
  }
}

function concatSegments(segmentPaths, outputPath) {
  const listPath = outputPath + ".list.txt";
  writeFileSync(listPath, segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  try {
    execFileSync(ffmpegPath, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart",
      outputPath,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });
  } finally {
    try { unlinkSync(listPath); } catch {}
  }
}

// Always builds fresh and uploads a NEW Drive file -- callers decide
// whether that's appropriate (first-ever generation) or explicit
// (Regenerate); the cache read/write lives in the route handlers below, not
// here, so this stays a plain "do the work" function.
async function renderAndUploadMontage(user) {
  const favorites = favoritesForUser(user).slice(-MAX_CLIPS); // most recent MAX_CLIPS
  if (!favorites.length) return null;

  const accessToken = await getDriveAccessToken();
  const ts = randomUUID();
  const tempFiles = [];
  const segments = [];
  try {
    for (let i = 0; i < favorites.length; i++) {
      const f = favorites[i];
      const isImage = f.type !== "video";
      const rawPath = join(tmpdir(), `montage_raw_${ts}_${i}${isImage ? ".jpg" : ".mp4"}`);
      const segPath = join(tmpdir(), `montage_seg_${ts}_${i}.mp4`);
      tempFiles.push(rawPath, segPath);
      await downloadDriveFile(f.driveFileId, accessToken, rawPath);
      normalizeSegment(rawPath, segPath, { isImage });
      segments.push(segPath);
    }
    const outPath = join(tmpdir(), `montage_out_${ts}.mp4`);
    tempFiles.push(outPath);
    concatSegments(segments, outPath);

    const cfg = readJson("chat_admin_config.json", {});
    const uploaded = await uploadStreamToDrive(createReadStream(outPath), {
      name: `${user.first} ${user.last} PHYSIQUE MONTAGE ${ts}`.toUpperCase() + ".mp4",
      mimeType: "video/mp4",
      folderId: cfg.physiqueMontageFolderId || cfg.favoritesFolderId || cfg.chatVideosFolderId,
      accessToken,
    });
    return { driveFileId: uploaded.id, createdAt: new Date().toISOString(), clipCount: favorites.length };
  } finally {
    tempFiles.forEach(p => { try { unlinkSync(p); } catch {} });
  }
}

function getCachedMontage(userId) {
  return readJson(MONTAGES_FILE, {})[userId] || null;
}
function setCachedMontage(userId, montage) {
  const all = readJson(MONTAGES_FILE, {});
  all[userId] = montage;
  writeJson(MONTAGES_FILE, all);
}

export async function handleFavoritesMontageRequest(req, res, url) {
  // Cached-first: once a montage exists for this student it just keeps
  // being served, no rebuild, until they explicitly regenerate it.
  if (url.pathname === "/api/body-reports/montage" && req.method === "GET") {
    const user = resolveTargetUser(req, url);
    if (!user) return sendJson(res, 401, { error: "Not logged in" }), true;
    try {
      let montage = getCachedMontage(user.id);
      if (!montage) {
        montage = await renderAndUploadMontage(user);
        if (montage) setCachedMontage(user.id, montage);
      }
      sendJson(res, 200, { montage });
    } catch (e) {
      console.error("[favorites-montage]", e.stack || e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // Explicit re-build -- ignores/overwrites whatever was cached, uploads a
  // fresh Drive file (the old one is left in place, not deleted) with
  // whatever's currently favorited.
  if (url.pathname === "/api/body-reports/montage/regenerate" && req.method === "POST") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" }), true;
    try {
      const montage = await renderAndUploadMontage(user);
      if (montage) setCachedMontage(user.id, montage);
      sendJson(res, 200, { montage });
    } catch (e) {
      console.error("[favorites-montage] regenerate", e.stack || e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // Authenticated proxy for playing the montage back -- login is enough
  // here (not scoped to "this exact user's own montage") since the file id
  // is opaque/unguessable and isn't exposed anywhere a listing could leak
  // it.
  const mediaMatch = url.pathname.match(/^\/api\/body-reports\/montage\/media\/([^/]+)$/);
  if (mediaMatch && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user) { res.writeHead(401); res.end(); return true; }
    try {
      const accessToken = await getDriveAccessToken();
      await streamDriveMedia(req, res, mediaMatch[1], accessToken);
    } catch (e) {
      res.writeHead(500); res.end("Media fetch failed: " + e.message);
    }
    return true;
  }

  return false;
}
