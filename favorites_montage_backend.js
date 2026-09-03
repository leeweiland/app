// favorites_montage_backend.js — builds a horizontal 16:9 highlight-reel
// video from a student's coach-favorited photos/videos, shown at the top of
// that student's Physique Builder Reports tab. Reuses the same Drive-
// download/ffmpeg conventions as social_video_backend.js's vertical reframe
// (execFileSync + ffmpeg-static), just horizontal (letterboxed 16:9) and
// drawing from chat_favorites.json instead of one fresh upload.
//
// Test-run cut: builds fresh on every request, no caching. Fine for proving
// the mechanic works; a real ship of this should cache the result (keyed by
// which favorite ids went into it) so a student loading Reports repeatedly
// doesn't re-download/re-encode every favorite every time.

import { writeFileSync, unlinkSync, createReadStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import ffmpegPath from "ffmpeg-static";
import {
  readJson, getSessionUser, getDriveAccessToken, uploadStreamToDrive, sendJson, streamDriveMedia,
} from "./chat_backend.js";

const FAVORITES_FILE = "chat_favorites.json";
const CONVOS_FILE = "chat_conversations.json";

const OUT_W = 1920, OUT_H = 1080;
const IMAGE_CLIP_SECONDS = 3.5;
const MAX_VIDEO_CLIP_SECONDS = 6;
const MAX_CLIPS = 10; // keeps montage length/compute bounded

// A coach's favorite is tagged with the source conversationId -- every
// favorite from a conversation this user participates in is "their"
// favorited media, regardless of which coach starred it.
function favoritesForUser(userId) {
  const convos = readJson(CONVOS_FILE, []);
  const myConvoIds = new Set(convos.filter(c => c.participantIds.includes(userId)).map(c => c.id));
  const all = readJson(FAVORITES_FILE, []);
  return all.filter(f => f.conversationId && myConvoIds.has(f.conversationId) && f.driveFileId)
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

export async function buildFavoritesMontage(userId) {
  const favorites = favoritesForUser(userId).slice(-MAX_CLIPS); // most recent MAX_CLIPS
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
      name: `PHYSIQUE MONTAGE ${ts}.mp4`,
      mimeType: "video/mp4",
      folderId: cfg.favoritesFolderId || cfg.chatVideosFolderId,
      accessToken,
    });
    return { driveFileId: uploaded.id, clipCount: favorites.length };
  } finally {
    tempFiles.forEach(p => { try { unlinkSync(p); } catch {} });
  }
}

export async function handleFavoritesMontageRequest(req, res, url) {
  if (url.pathname === "/api/body-reports/montage" && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" }), true;
    try {
      const montage = await buildFavoritesMontage(user.id);
      sendJson(res, 200, { montage });
    } catch (e) {
      console.error("[favorites-montage]", e.stack || e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // Authenticated proxy for playing the montage back -- login is enough
  // here (not scoped to "this exact user's own montage") since the file id
  // is opaque/unguessable and isn't persisted anywhere a listing could leak
  // it; a real ship of this (once montages are cached/persisted per user)
  // should tighten this to an actual ownership check, same as the other
  // media proxies in this app.
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
