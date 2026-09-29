// social_video_backend.js — the favorite-star pipeline for Powerbatics: a
// coach trims a clip, types a label, and it's saved permanently to Drive
// under that label. Used to also reframe the clip vertical, generate an AI
// caption, and schedule it to Metricool -- all of that (and the matching
// Pacific Rim Athletics pipeline in the now-deleted
// pacific_rim_video_backend.js) was removed per Lee's explicit ask to keep
// this to just trim -> label -> save. Mounted from server.js the same way
// body_analysis_backend.js / moves_dictionary_backend.js are.

import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import ffmpegPath from "ffmpeg-static";
import {
  readJson, getSessionUser, isStaff, readJsonBody, sendJson, getDriveAccessToken,
} from "./chat_backend.js";
import { logActivity } from "./activity_log_backend.js";

// ── HTTP routes ──────────────────────────────────────────────────────────
export async function handleSocialVideoRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/social-video/")) return false;

  const user = getSessionUser(req);
  if (!user || !isStaff(user)) { sendJson(res, 403, { error: "Staff only" }); return true; }

  // Trim + label + save to Drive -- the entire favorite-star pipeline.
  if (p === "/api/social-video/save" && req.method === "POST") {
    const body = await readJsonBody(req);
    const { driveFileId, trimStart, trimEnd, label } = body;
    if (!driveFileId) return void sendJson(res, 400, { error: "driveFileId required" });
    if (!label || !label.trim()) return void sendJson(res, 400, { error: "Label required" });

    const accessToken = await getDriveAccessToken();
    const { tmpdir } = await import("os");
    const { randomUUID } = await import("crypto");
    const { uploadStreamToDrive } = await import("./chat_backend.js");
    const { createReadStream } = await import("fs");
    const ts = randomUUID();
    const tmpIn = join(tmpdir(), `sv_in_${ts}.mp4`);
    const tmpTrimmed = join(tmpdir(), `sv_trim_${ts}.mp4`);

    let savedFileId = null;
    try {
      const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!dlRes.ok) throw new Error(`Drive download failed: ${dlRes.status}`);
      writeFileSync(tmpIn, Buffer.from(await dlRes.arrayBuffer()));

      // Trim -- this is required, not optional, since the saved-to-Drive
      // file IS the trimmed clip (untrimmed start/end just means "keep the
      // whole thing," not "skip trimming").
      const start = Number.isFinite(trimStart) ? Math.max(0, trimStart) : 0;
      const end = Number.isFinite(trimEnd) && trimEnd > start ? trimEnd : null;
      execFileSync(ffmpegPath, [
        "-y", "-ss", String(start), "-i", tmpIn,
        ...(end ? ["-t", String(end - start)] : []),
        "-c:v", "libx264", "-c:a", "aac", "-preset", "veryfast", "-avoid_negative_ts", "make_zero",
        tmpTrimmed,
      ], { stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });

      const cfg = readJson("chat_admin_config.json", {});
      const saveResult = await uploadStreamToDrive(createReadStream(tmpTrimmed), {
        name: label.trim().slice(0, 200) + ".mp4",
        mimeType: "video/mp4",
        folderId: cfg.favoritesFolderId || cfg.chatVideosFolderId,
        accessToken,
      });
      savedFileId = saveResult.id;
    } catch (e) {
      return void sendJson(res, 500, { error: "Could not save clip: " + e.message });
    } finally {
      [tmpIn, tmpTrimmed].forEach(f => { try { unlinkSync(f); } catch {} });
    }

    logActivity(user.id, "video_favorited", `Favorited a video: ${label.trim()}`, { driveFileId: savedFileId });
    sendJson(res, 200, { savedFileId });
    return true;
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}
