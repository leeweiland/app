// social_video_backend.js — the favorite-click auto-clip-and-schedule pipeline:
// trim (see chat_backend.js's trimVideo, reused for the initial cut) -> vertical
// reframe -> AI caption generation (brand-voice RAG) -> schedule to Metricool.
// Ported from Lee's local-only social-video.html + root server.js — see that
// investigation for what changed in translation. Mounted from server.js the
// same way body_analysis_backend.js / moves_dictionary_backend.js are.

import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import ffmpegPath from "ffmpeg-static";
import {
  DATA_DIR, readJson, writeJson, getSessionUser, isStaff,
  readJsonBody, sendJson, getDriveAccessToken,
} from "./chat_backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = "social_video_settings.json"; // DATA_DIR — admin-editable brand voice + own-words ratio
// chunks_cache.json is committed to git (read-only at runtime, ~22MB, never
// written by this app) rather than routed through DATA_DIR/migrateDataFile —
// it doesn't need per-deploy persistence, just needs to exist, and living
// straight in __dirname means it survives every deploy without a migration
// step. Rebuilding it (new writings, new campaigns) is a manual/offline step
// on Lee's local machine, same as it is today — this app only ever reads it.
const CHUNKS_CACHE_PATH = join(__dirname, "chunks_cache.json");

// ── RAG voice-bank retrieval (ported from semantic_retrieve.js) ────────────
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMS = 512;
let _chunksMemo = null; // { mtimeMs, chunks } — the 22MB file only gets re-parsed when it actually changes on disk

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function loadChunks() {
  const stat = statSync(CHUNKS_CACHE_PATH);
  if (_chunksMemo && _chunksMemo.mtimeMs === stat.mtimeMs) return _chunksMemo.chunks;
  const cache = JSON.parse(readFileSync(CHUNKS_CACHE_PATH, "utf8"));
  _chunksMemo = { mtimeMs: stat.mtimeMs, chunks: cache.chunks || [] };
  return _chunksMemo.chunks;
}

async function embedQuery(query) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: query, dimensions: EMBED_DIMS }),
  });
  if (!r.ok) throw new Error(`OpenAI embed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.data[0].embedding;
}

export async function semanticRetrieve(query, { topN = 20 } = {}) {
  if (!existsSync(CHUNKS_CACHE_PATH)) return [];
  const chunks = loadChunks();
  const queryVec = await embedQuery(query);
  return chunks
    .map(c => ({ ...c, score: cosineSimilarity(queryVec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(({ embedding: _e, ...rest }) => rest);
}

// ── Caption generation (Claude + RAG voice bank) ────────────────────────────
// hasTitle gates whether a platform gets its own Title field in the caption
// JSON/UI — matches social-video.html's PLATFORMS table exactly.
export const CAPTION_PLATFORMS = [
  { id: "fb", label: "Facebook", hasTitle: true, titleLimit: 255, descLimit: 5000 },
  { id: "ig", label: "Instagram", hasTitle: false, descLimit: 2200 },
  { id: "yt", label: "YouTube", hasTitle: true, titleLimit: 100, descLimit: 5000 },
  { id: "tt", label: "TikTok", hasTitle: false, descLimit: 900 },
  { id: "li", label: "LinkedIn", hasTitle: false, descLimit: 3000 },
  { id: "x", label: "X", hasTitle: false, descLimit: 280 },
];

function ownWordsRuleFor(ratio) {
  if (ratio >= 90) return "STRICT COPY-PASTE MODE: reuse the voice bank's exact sentences and phrasing as much as possible — light edits only to make them fit this specific clip.";
  if (ratio <= 10) return "Write completely fresh copy in the brand voice described below — don't quote the voice bank directly, just match its tone and style.";
  return `Blend roughly ${ratio}% reused phrasing/sentences from the voice bank with your own fresh writing tailored to this clip.`;
}

export async function generateCaptions({ description }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const settings = readJson(SETTINGS_FILE, {});
  const brandPrompt = settings.aiPrompt || "Write bold, direct, no-fluff training-focused social captions.";
  const ownWordsRatio = Number.isFinite(settings.ownWordsRatio) ? settings.ownWordsRatio : 60;

  let chunks = [];
  try { chunks = await semanticRetrieve(description || "training video caption", { topN: 20 }); }
  catch (e) { console.error("[generateCaptions] semanticRetrieve failed, continuing without voice bank:", e.message); }
  const voiceBlock = chunks.length
    ? chunks.map(c => `--- ${c.type === "campaign" ? "EMAIL" : "DOC"}: ${c.source} ---\n${c.text}`).join("\n\n")
    : "(no voice-bank matches found — write fresh copy in the brand voice below)";

  const sharedContext = `BRAND VOICE INSTRUCTIONS:\n${brandPrompt}\n\n${ownWordsRuleFor(ownWordsRatio)}\n\nVOICE BANK (real past writing to draw from):\n${voiceBlock}\n\n${description ? `WHAT'S IN THIS CLIP: ${description}\n\n` : ""}This caption is for the Powerbatics brand.`;

  // One focused call per platform (run in parallel) rather than one call
  // asked to fill all 6 at once — tested live and found that with the full
  // voice-bank context injected (10-20K+ characters), a single combined
  // call reliably nailed the FIRST platform in the schema and left the
  // rest as empty {}, well under the token budget so not a truncation
  // issue — just the model's attention thinning out across a long list of
  // sibling fields. Six small, single-purpose calls can't leave anything
  // blank because there's nothing else in that call's schema to neglect.
  async function writeOnePlatform(id, label, hasTitle, charLimit, titleLimit) {
    const schema = hasTitle
      ? { type: "object", properties: { title: { type: "string" }, desc: { type: "string" } }, required: ["title", "desc"] }
      : { type: "object", properties: { desc: { type: "string" } }, required: ["desc"] };
    const limitLine = hasTitle ? `Title must be <=${titleLimit} characters. Description must be <=${charLimit} characters.` : `Must be <=${charLimit} characters.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1500,
        system: "You are a social media caption writer.",
        messages: [{ role: "user", content: `${sharedContext}\n\nWrite the ${label} caption for this clip. ${limitLine}` }],
        tools: [{ name: "write_caption", description: `Write the ${label} caption.`, input_schema: schema }],
        tool_choice: { type: "tool", name: "write_caption" },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Claude ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    const toolUse = data.content?.find(b => b.type === "tool_use");
    if (!toolUse?.input?.desc) throw new Error(`Claude returned no ${label} caption`);
    return toolUse.input;
  }

  const results = await Promise.all(CAPTION_PLATFORMS.map(p => writeOnePlatform(p.id, p.label, p.hasTitle, p.descLimit, p.titleLimit)));
  const captions = {};
  CAPTION_PLATFORMS.forEach((p, i) => { captions[p.id] = results[i]; });
  return captions;
}

// ── Vertical reframe (ffmpeg, ported from root server.js's buildDynamicCrop) ──
// Downsamples keyframes to ≤40 control points so the ffmpeg filter expression
// stays a sane length, then builds a piecewise-linear crop x/y expression —
// unchanged from the original algorithm, just re-hosted.
function buildDynamicCrop(kfs, vw, vh, fW, fH, startTime) {
  const MAX_KFS = 40;
  const sampled = kfs.length > MAX_KFS
    ? kfs.filter((_, i) => i === 0 || i === kfs.length - 1 || i % Math.ceil(kfs.length / MAX_KFS) === 0)
    : kfs;
  const s = (sampled[0]?.scale || 100) / 100;
  const cropW = Math.min(Math.round(fW / s), vw);
  const cropH = Math.min(Math.round(fH / s), vh);
  const maxCX = Math.max(0, vw - cropW);
  const maxCY = Math.max(0, vh - cropH);
  const pts = sampled.map(kf => ({
    t: Math.max(0, parseFloat((kf.time - startTime).toFixed(3))),
    x: Math.max(0, Math.min(maxCX, Math.round((vw - cropW) / 2 - kf.offsetX / s))),
    y: Math.max(0, Math.min(maxCY, Math.round((vh - cropH) / 2 - kf.offsetY / s))),
  }));
  function mkExpr(coord, max) {
    if (pts.length < 2) return String(pts[0]?.[coord] ?? 0);
    let e = String(pts[pts.length - 1][coord]);
    for (let i = pts.length - 2; i >= 0; i--) {
      const t0 = pts[i].t, v0 = pts[i][coord];
      const t1 = pts[i + 1].t, v1 = pts[i + 1][coord];
      const dt = parseFloat((t1 - t0).toFixed(3));
      if (dt <= 0) continue;
      const lerp = v0 === v1 ? String(v0) : `clip(${v0}+(${v1 - v0})*(t-${t0})/${dt},0,${max})`;
      e = `if(lte(t,${t0}),${v0},if(lte(t,${t1}),${lerp},${e}))`;
    }
    return e;
  }
  return { cropW, cropH, xExpr: mkExpr("x", maxCX), yExpr: mkExpr("y", maxCY) };
}

// keyframes: [{time, scale, offsetX, offsetY}, ...] from the client-side
// tracker (see the favorite-modal's runAutoTrack), or omitted entirely for a
// plain static center crop (subject wasn't tracked / video has no tracking).
export function reframeVideoVertical(inputPath, outputPath, { videoWidth, videoHeight, frameW = 240, frameH = 426, startTime = 0, keyframes, squareMode = false }) {
  const outW = 1080, outH = squareMode ? 1080 : 1920;
  let cropW, cropH, xExpr, yExpr;
  if (keyframes && keyframes.length >= 2) {
    ({ cropW, cropH, xExpr, yExpr } = buildDynamicCrop(keyframes, videoWidth, videoHeight, frameW, frameH, startTime));
  } else {
    const targetAspect = outW / outH;
    if (videoWidth / videoHeight > targetAspect) { cropH = videoHeight; cropW = Math.round(videoHeight * targetAspect); }
    else { cropW = videoWidth; cropH = Math.round(videoWidth / targetAspect); }
    xExpr = String(Math.round((videoWidth - cropW) / 2));
    yExpr = String(Math.round((videoHeight - cropH) / 2));
  }
  const vfFilter = `crop=${cropW}:${cropH}:'${xExpr}':'${yExpr}',scale=${outW}:${outH}`;
  const vfScriptPath = outputPath + ".vf.txt";
  writeFileSync(vfScriptPath, vfFilter, "utf8");
  try {
    execFileSync(ffmpegPath, [
      "-y", "-i", inputPath,
      "-filter_script:v", vfScriptPath,
      "-c:v", "libx264", "-preset", "fast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
  } finally {
    try { unlinkSync(vfScriptPath); } catch {}
  }
}

// chat-app's normal /api/chat/media/:id proxy requires a login session (it's
// gating access to what's otherwise a private student's chat) — Metricool's
// servers fetching `media` on a scheduled post obviously have no session
// cookie. Rather than build a whole separate unauthenticated-but-scoped
// endpoint, just flip the ONE output file actually being posted publicly
// (it's about to go out on Instagram/TikTok/etc. anyway) to "anyone with the
// link" on Drive itself, and hand Metricool that direct link.
async function makeDriveFilePublic(fileId, accessToken) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// ── Metricool ────────────────────────────────────────────────────────────
// Endpoints/shapes below were verified live against the real API while
// building this (Metricool's actual behavior differs from what root
// server.js's comments implied in a couple of places — dates must be
// 'yyyy-MM-ddTHH:mm:ss' with NO trailing Z/milliseconds, and there is no
// working /brands/{id}/social-accounts endpoint; connected-account ids come
// from /admin/simpleProfiles instead).
const METRICOOL_BASE = "https://app.metricool.com/api";
const NETWORK_TYPE_MAP = { fb: "facebook", ig: "instagram", yt: "youtube", tt: "tiktok", li: "linkedin", x: "twitter", fbs: "facebook", igs: "instagram" };

function metricoolAuth() {
  const apiKey = process.env.METRICOOL_API_KEY;
  const userId = process.env.METRICOOL_USER_ID;
  const blogId = process.env.METRICOOL_PB_BLOG_ID;
  if (!apiKey || !userId || !blogId) throw new Error("Metricool isn't configured — set METRICOOL_API_KEY, METRICOOL_USER_ID, METRICOOL_PB_BLOG_ID.");
  return { apiKey, userId, blogId };
}

function fmtMetricoolDate(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// The Powerbatics brand's connected-account id per network — cached in
// memory for a few minutes since it almost never changes and the
// scheduling flow may look it up several times in one session.
let _accountsMemo = null; // { at, accounts }
export async function getPbConnectedAccounts() {
  if (_accountsMemo && Date.now() - _accountsMemo.at < 5 * 60 * 1000) return _accountsMemo.accounts;
  const { apiKey, userId, blogId } = metricoolAuth();
  const r = await fetch(`${METRICOOL_BASE}/admin/simpleProfiles?userId=${userId}`, { headers: { "X-Mc-Auth": apiKey } });
  if (!r.ok) throw new Error(`Metricool simpleProfiles ${r.status}: ${await r.text()}`);
  const profiles = await r.json();
  const pb = profiles.find(p => String(p.id) === String(blogId));
  if (!pb) throw new Error(`No Metricool brand found for blogId ${blogId}`);
  const accounts = {
    facebook: pb.facebookPageId || null,
    instagram: pb.fbBusinessId || null,
    youtube: pb.youtube || null,
    tiktok: pb.tiktok || null,
    linkedin: pb.linkedinCompany || null,
    twitter: pb.twitter || null,
  };
  _accountsMemo = { at: Date.now(), accounts };
  return accounts;
}

export async function getScheduledPosts(startDate, endDate) {
  const { apiKey, userId, blogId } = metricoolAuth();
  const url = `${METRICOOL_BASE}/v2/scheduler/posts?userId=${userId}&blogId=${blogId}&start=${fmtMetricoolDate(startDate)}&end=${fmtMetricoolDate(endDate)}`;
  const r = await fetch(url, { headers: { "X-Mc-Auth": apiKey } });
  if (!r.ok) throw new Error(`Metricool posts ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.data || [];
}

// "Next open day" = earliest future calendar day (Metricool's own displayed
// date, per each post's own timezone) with ZERO Powerbatics posts scheduled
// on any platform — per Lee's explicit choice of "shared day for everything"
// over independently checking each platform.
export async function findNextOpenDay({ withinDays = 30 } = {}) {
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 1); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + withinDays);
  const posts = await getScheduledPosts(start, end);
  const bookedDays = new Set(posts.map(p => (p.publicationDate?.dateTime || "").slice(0, 10)));
  const d = new Date(start);
  for (let i = 0; i < withinDays; i++) {
    const key = d.toISOString().slice(0, 10);
    if (!bookedDays.has(key)) return key; // YYYY-MM-DD
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return null;
}

export function buildMetricoolPostBody({ platformId, accountId, text, title, mediaUrl, dateTimeStr }) {
  const networkType = NETWORK_TYPE_MAP[platformId];
  const body = {
    providers: [{ network: networkType, id: accountId }],
    // Facebook has no native title field in Metricool's post API — fold the
    // title into the text body instead, same as the original implementation.
    text: platformId === "fb" && title ? (text ? `${title}\n\n${text}` : title) : (text || ""),
    media: mediaUrl ? [mediaUrl] : [],
    saveExternalMediaFiles: true,
    publicationDate: { dateTime: dateTimeStr, timezone: "UTC" },
    autoPublish: true,
  };
  if (networkType === "instagram") body.instagramData = { type: platformId === "igs" ? "STORY" : "REEL" };
  if (networkType === "facebook") body.facebookData = { type: platformId === "fbs" ? "STORY" : "REEL" };
  if (networkType === "tiktok") body.tiktokData = { privacyOption: "PUBLIC_TO_EVERYONE" };
  if (networkType === "youtube") body.youtubeData = { title: title || (text || "").slice(0, 100) || "Video", madeForKids: false };
  return body;
}

// The actual publish call — NOT invoked anywhere in this file's own tests;
// only the favorite-modal's "Schedule to Powerbatics" button (a real coach
// clicking a real button) should ever call this in practice.
export async function schedulePost(postBody) {
  const { apiKey, userId, blogId } = metricoolAuth();
  const r = await fetch(`${METRICOOL_BASE}/v2/scheduler/posts?userId=${userId}&blogId=${blogId}`, {
    method: "POST",
    headers: { "X-Mc-Auth": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(postBody),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Metricool publish ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// ── HTTP routes ──────────────────────────────────────────────────────────
export async function handleSocialVideoRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/social-video/")) return false;

  const user = getSessionUser(req);
  if (!user || !isStaff(user)) { sendJson(res, 403, { error: "Staff only" }); return true; }

  if (p === "/api/social-video/settings") {
    if (req.method === "GET") {
      const settings = readJson(SETTINGS_FILE, { aiPrompt: "", ownWordsRatio: 60 });
      sendJson(res, 200, {
        ...settings,
        metricoolConfigured: !!(process.env.METRICOOL_API_KEY && process.env.METRICOOL_USER_ID && process.env.METRICOOL_PB_BLOG_ID),
        anthropicConfigured: !!process.env.ANTHROPIC_API_KEY,
        openaiConfigured: !!process.env.OPENAI_API_KEY,
      });
      return true;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const current = readJson(SETTINGS_FILE, {});
      if (body.aiPrompt !== undefined) current.aiPrompt = String(body.aiPrompt).slice(0, 8000);
      if (body.ownWordsRatio !== undefined) current.ownWordsRatio = Math.max(0, Math.min(100, Number(body.ownWordsRatio) || 0));
      writeJson(SETTINGS_FILE, current);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (p === "/api/social-video/generate-caption" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const captions = await generateCaptions({ description: body.description || "" });
      sendJson(res, 200, { captions, platforms: CAPTION_PLATFORMS });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  if (p === "/api/social-video/next-open-day" && req.method === "GET") {
    try {
      const day = await findNextOpenDay({});
      sendJson(res, 200, { day });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  if (p === "/api/social-video/reframe" && req.method === "POST") {
    // Downloads the source clip from Drive (chat-app's own Drive folder —
    // the favorited video is already a chat message's driveFileId, no
    // separate brand-token juggling needed the way the original did),
    // trims + vertically reframes it, re-uploads the result, and returns
    // its new driveFileId. Does NOT touch Metricool — scheduling is a
    // separate, explicit step.
    try {
      const body = await readJsonBody(req);
      const { driveFileId, trimStart, trimEnd, videoWidth, videoHeight, keyframes, squareMode } = body;
      if (!driveFileId) return void sendJson(res, 400, { error: "driveFileId required" });
      const accessToken = await getDriveAccessToken();
      const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!dlRes.ok) throw new Error(`Drive download failed: ${dlRes.status}`);
      const buf = Buffer.from(await dlRes.arrayBuffer());
      const { tmpdir } = await import("os");
      const { randomUUID } = await import("crypto");
      const ts = randomUUID();
      const tmpIn = join(tmpdir(), `sv_in_${ts}.mp4`);
      const tmpTrimmed = join(tmpdir(), `sv_trim_${ts}.mp4`);
      const tmpOut = join(tmpdir(), `sv_out_${ts}.mp4`);
      writeFileSync(tmpIn, buf);
      try {
        let sourcePath = tmpIn;
        if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
          execFileSync(ffmpegPath, [
            "-y", "-ss", String(Math.max(0, trimStart)), "-i", tmpIn,
            "-t", String(Math.max(0.1, trimEnd - trimStart)),
            "-c:v", "libx264", "-c:a", "aac", "-preset", "veryfast", "-avoid_negative_ts", "make_zero",
            tmpTrimmed,
          ], { stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });
          sourcePath = tmpTrimmed;
        }
        reframeVideoVertical(sourcePath, tmpOut, {
          videoWidth: videoWidth || 1920, videoHeight: videoHeight || 1080,
          startTime: Number(trimStart) || 0, keyframes, squareMode: !!squareMode,
        });
        const { uploadStreamToDrive } = await import("./chat_backend.js");
        const { createReadStream } = await import("fs");
        const cfg = readJson("chat_admin_config.json", {});
        const result = await uploadStreamToDrive(createReadStream(tmpOut), {
          name: `POWERBATICS VERTICAL ${Date.now()}.mp4`,
          mimeType: "video/mp4",
          folderId: cfg.favoritesFolderId || cfg.chatVideosFolderId,
          accessToken,
        });
        const publicMediaUrl = await makeDriveFilePublic(result.id, accessToken);
        sendJson(res, 200, { driveFileId: result.id, publicMediaUrl });
      } finally {
        [tmpIn, tmpTrimmed, tmpOut].forEach(f => { try { unlinkSync(f); } catch {} });
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  if (p === "/api/social-video/schedule" && req.method === "POST") {
    // The real publish step — schedules the ALREADY-REFRAMED clip (its
    // Drive file must already be publicly-fetchable for Metricool to pull
    // it as `media`) across whichever platforms the coach picked.
    try {
      const body = await readJsonBody(req);
      const { driveFileId, mediaUrl, captions, platformIds, dateTimeStr } = body;
      if (!mediaUrl) return void sendJson(res, 400, { error: "mediaUrl required (a URL Metricool can fetch — see notes)" });
      if (!Array.isArray(platformIds) || !platformIds.length) return void sendJson(res, 400, { error: "platformIds required" });
      const accounts = await getPbConnectedAccounts();
      const results = [];
      for (const platformId of platformIds) {
        const networkType = NETWORK_TYPE_MAP[platformId];
        const accountId = accounts[networkType];
        if (!accountId) { results.push({ platformId, error: `No connected ${networkType} account found` }); continue; }
        const plat = captions?.[platformId.replace(/s$/, "")] || {}; // fbs/igs share fb/ig's caption
        const postBody = buildMetricoolPostBody({ platformId, accountId, text: plat.desc, title: plat.title, mediaUrl, dateTimeStr });
        try {
          const r = await schedulePost(postBody);
          results.push({ platformId, ok: true, result: r });
        } catch (e) {
          results.push({ platformId, ok: false, error: e.message });
        }
      }
      sendJson(res, 200, { results });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}
