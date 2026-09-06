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
// Every network this pipeline is capable of publishing to -- shared shape
// with pacific_rim_video_backend.js's own settings, so an admin can switch
// any of them off (per brand) without touching which Metricool accounts are
// actually connected (that part still auto-detects via getConnectedAccounts).
export const DEFAULT_PLATFORMS = { fb: true, fbs: true, ig: true, igs: true, li: true, tt: true, x: true, yt: true };
export function getSocialVideoSettings() {
  const saved = readJson(SETTINGS_FILE, {});
  return {
    aiPrompt: "", ownWordsRatio: 60, postHour: 3, timezone: "America/Anchorage",
    ...saved,
    platforms: { ...DEFAULT_PLATFORMS, ...(saved.platforms || {}) },
  };
}
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

export function ownWordsRuleFor(ratio) {
  if (ratio >= 90) return "STRICT COPY-PASTE MODE: reuse the voice bank's exact sentences and phrasing as much as possible — light edits only to make them fit this specific clip.";
  if (ratio <= 10) return "Write completely fresh copy in the brand voice described below — don't quote the voice bank directly, just match its tone and style.";
  return `Blend roughly ${ratio}% reused phrasing/sentences from the voice bank with your own fresh writing tailored to this clip.`;
}

// The Claude-calling half of caption generation, shared across brands — each
// brand builds its own sharedContext (its own settings file, its own brand
// name/voice) and hands it here. One focused call per platform (run in
// parallel) rather than one call asked to fill all 6 at once — tested live
// and found that with the full voice-bank context injected (10-20K+
// characters), a single combined call reliably nailed the FIRST platform in
// the schema and left the rest as empty {}, well under the token budget so
// not a truncation issue — just the model's attention thinning out across a
// long list of sibling fields. Six small, single-purpose calls can't leave
// anything blank because there's nothing else in that call's schema to
// neglect.
export async function generateCaptionsFromContext(sharedContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
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

export async function generateCaptions({ description }) {
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
  return generateCaptionsFromContext(sharedContext);
}

// ── Vertical reframe (ffmpeg, ported from root server.js's buildDynamicCrop) ──
// Downsamples keyframes to ≤40 control points so the ffmpeg filter expression
// stays a sane length, then builds a piecewise-linear crop x/y expression.
//
// Bug fixed here vs. the original port: cropW/cropH used to be derived from
// frameW/frameH (240/426) directly — but those are a client-side design-
// space reference for the UI's pan-limit math, not literal pixel dimensions
// in the SOURCE video's own coordinate space. Using them as if they were
// produced a crop window only ~200px wide regardless of the real video's
// resolution — an extreme, blown-out zoom on any real (1080p+) clip. Fixed
// by deriving a "base" 9:16 crop from the real vw/vh first (identical math
// to the static-crop branch below), then zooming IN from that by dividing
// by each keyframe's scale — the offsetX/offsetY math was already correct
// (the /s there cancels out against how offsetX was computed client-side),
// only the crop window's SIZE was wrong.
function buildDynamicCrop(kfs, vw, vh, outW, outH, startTime) {
  const MAX_KFS = 40;
  const sampled = kfs.length > MAX_KFS
    ? kfs.filter((_, i) => i === 0 || i === kfs.length - 1 || i % Math.ceil(kfs.length / MAX_KFS) === 0)
    : kfs;
  const targetAspect = outW / outH;
  let baseCropW, baseCropH;
  if (vw / vh > targetAspect) { baseCropH = vh; baseCropW = Math.round(vh * targetAspect); }
  else { baseCropW = vw; baseCropH = Math.round(vw / targetAspect); }
  const s = (sampled[0]?.scale || 100) / 100;
  const cropW = Math.min(Math.round(baseCropW / s), vw);
  const cropH = Math.min(Math.round(baseCropH / s), vh);
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

// Vertical source footage (already taller than wide) doesn't need cropping
// at all — passed straight through with a stream copy (fast, lossless).
// Horizontal footage gets reframed into 9:16 — AI-tracked (buildDynamicCrop,
// now fixed) if keyframes came from the client's subject tracker (a coach
// deliberately chose to follow a subject, discarding the rest on purpose —
// crop-to-fill is the point there), otherwise the WHOLE frame is scaled
// down to fit and letterboxed (padded black top/bottom) instead of
// center-cropped — nothing gets cut off just to fill a vertical canvas
// when nobody actually chose what to crop to.
export function reframeVideoVertical(inputPath, outputPath, { videoWidth, videoHeight, startTime = 0, keyframes, squareMode = false }) {
  if (videoWidth <= videoHeight) {
    execFileSync(ffmpegPath, ["-y", "-i", inputPath, "-c", "copy", "-movflags", "+faststart", outputPath], { stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
    return;
  }
  const outW = 1080, outH = squareMode ? 1080 : 1920;
  let vfFilter;
  if (keyframes && keyframes.length >= 2) {
    const { cropW, cropH, xExpr, yExpr } = buildDynamicCrop(keyframes, videoWidth, videoHeight, outW, outH, startTime);
    vfFilter = `crop=${cropW}:${cropH}:'${xExpr}':'${yExpr}',scale=${outW}:${outH}`;
  } else {
    vfFilter = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }
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
export async function makeDriveFilePublic(fileId, accessToken) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  // confirm=t skips Google's "can't scan this file for viruses" interstitial
  // HTML page that Drive serves instead of the actual bytes for larger
  // files — without it, Metricool's saveExternalMediaFiles fetch could get
  // that warning page back instead of the video. Matches the URL format the
  // already-working root server.js social-video publish flow uses.
  return `https://drive.google.com/uc?id=${fileId}&export=download&confirm=t`;
}

// ── Metricool ────────────────────────────────────────────────────────────
// Endpoints/shapes below were verified live against the real API while
// building this (Metricool's actual behavior differs from what root
// server.js's comments implied in a couple of places — dates must be
// 'yyyy-MM-ddTHH:mm:ss' with NO trailing Z/milliseconds, and there is no
// working /brands/{id}/social-accounts endpoint; connected-account ids come
// from /admin/simpleProfiles instead).
export const METRICOOL_BASE = "https://app.metricool.com/api";
export const NETWORK_TYPE_MAP = { fb: "facebook", ig: "instagram", yt: "youtube", tt: "tiktok", li: "linkedin", x: "twitter", fbs: "facebook", igs: "instagram" };

// HTTP header values must be Latin1 — Node's fetch() throws an opaque
// "Cannot convert argument to a ByteString" TypeError (no var name, just a
// char index) if any of these env vars were copy-pasted with a stray
// smart-quote/bullet/etc from somewhere. Check up front so a bad Railway env
// var points straight at itself instead of surfacing as a mystery crash deep
// in a Metricool fetch call.
export function assertHeaderSafe(varName, value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255) {
      throw new Error(`${varName} contains an invalid character ("${value[i]}", code ${code}) at position ${i} — likely a copy-paste artifact. Re-copy the value from Metricool and re-save it in Railway's env vars.`);
    }
  }
}

// apiKey/userId are Metricool-ACCOUNT-level (shared across every brand/blog
// on that account); blogId is the one brand-specific piece — callers pass
// their own brand's blogId (e.g. process.env.METRICOOL_PB_BLOG_ID for
// Powerbatics, METRICOOL_PRA_BLOG_ID for Pacific Rim Athletics).
export function metricoolAuth(blogId) {
  const apiKey = process.env.METRICOOL_API_KEY;
  const userId = process.env.METRICOOL_USER_ID;
  if (!apiKey || !userId || !blogId) throw new Error("Metricool isn't configured — set METRICOOL_API_KEY, METRICOOL_USER_ID, and this brand's blog id.");
  assertHeaderSafe("METRICOOL_API_KEY", apiKey);
  assertHeaderSafe("METRICOOL_USER_ID", userId);
  assertHeaderSafe("blogId", blogId);
  return { apiKey, userId, blogId };
}

function fmtMetricoolDate(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// A brand's connected-account id per network — cached in memory (per blogId,
// so multiple brands never share/clobber each other's entry) for a few
// minutes since it almost never changes and the scheduling flow may look it
// up several times in one session.
const _accountsMemoByBlog = new Map(); // blogId -> { at, accounts }
export async function getConnectedAccounts(auth) {
  const { apiKey, userId, blogId } = auth;
  const cached = _accountsMemoByBlog.get(blogId);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.accounts;
  const r = await fetch(`${METRICOOL_BASE}/admin/simpleProfiles?userId=${userId}`, { headers: { "X-Mc-Auth": apiKey } });
  if (!r.ok) throw new Error(`Metricool simpleProfiles ${r.status}: ${await r.text()}`);
  const profiles = await r.json();
  const brand = profiles.find(p => String(p.id) === String(blogId));
  if (!brand) throw new Error(`No Metricool brand found for blogId ${blogId}`);
  const accounts = {
    facebook: brand.facebookPageId || null,
    instagram: brand.fbBusinessId || null,
    youtube: brand.youtube || null,
    tiktok: brand.tiktok || null,
    linkedin: brand.linkedinCompany || null,
    twitter: brand.twitter || null,
  };
  _accountsMemoByBlog.set(blogId, { at: Date.now(), accounts });
  return accounts;
}

export async function getScheduledPosts(auth, startDate, endDate) {
  const { apiKey, userId, blogId } = auth;
  const url = `${METRICOOL_BASE}/v2/scheduler/posts?userId=${userId}&blogId=${blogId}&start=${fmtMetricoolDate(startDate)}&end=${fmtMetricoolDate(endDate)}`;
  const r = await fetch(url, { headers: { "X-Mc-Auth": apiKey } });
  if (!r.ok) throw new Error(`Metricool posts ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.data || [];
}

// en-CA formats as YYYY-MM-DD — matches the literal date portion Metricool
// posts are submitted/echoed with, given every post below is scheduled at a
// fixed wall-clock time in whichever timezone the brand's own settings pick.
function dayStrInTimezone(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}
function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// "Next open day" = earliest future calendar day (in the brand's own
// configured timezone) with ZERO posts scheduled on any platform — per
// Lee's explicit choice of "shared day for everything" over independently
// checking each platform. Previously computed "tomorrow" off a UTC midnight
// boundary while every post is actually scheduled at a fixed wall-clock
// time in a specific timezone — those two clocks can disagree about which
// calendar day "today"/"tomorrow" even is by up to ~14 hours, which was
// producing wrong/colliding days.
export async function findNextOpenDay(auth, { withinDays = 30, timezone = "America/Anchorage" } = {}) {
  const startDay = addDaysToDateStr(dayStrInTimezone(new Date(), timezone), 1);
  // getScheduledPosts just needs a real Date range to query Metricool with —
  // padded a day either side since it's only fetching a candidate window,
  // not itself the source of truth for which day something lands on.
  const start = new Date(startDay + "T00:00:00Z");
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + withinDays + 1);
  const posts = await getScheduledPosts(auth, start, end);
  const bookedDays = new Set(posts.map(p => (p.publicationDate?.dateTime || "").slice(0, 10)));
  let day = startDay;
  for (let i = 0; i < withinDays; i++) {
    if (!bookedDays.has(day)) return day; // YYYY-MM-DD
    day = addDaysToDateStr(day, 1);
  }
  return null;
}

export function buildMetricoolPostBody({ platformId, accountId, text, title, mediaUrl, dateTimeStr, timezone = "America/Anchorage", thumbnailUrl, coverMilliseconds }) {
  const networkType = NETWORK_TYPE_MAP[platformId];
  const body = {
    providers: [{ network: networkType, id: accountId }],
    // Facebook has no native title field in Metricool's post API — fold the
    // title into the text body instead, same as the original implementation.
    text: platformId === "fb" && title ? (text ? `${title}\n\n${text}` : title) : (text || ""),
    media: mediaUrl ? [mediaUrl] : [],
    saveExternalMediaFiles: true,
    // dateTimeStr is always a literal "THH:00:00" wall-clock string — tagging
    // it timezone:"UTC" would schedule it at that hour UTC instead of that
    // hour in the brand's own configured zone (previously hardcoded to
    // America/Anchorage; a mismatch here is exactly what caused the
    // original day-collision bug: findNextOpenDay's bookedDays came back
    // shifted a day from what the calendar actually shows).
    publicationDate: { dateTime: dateTimeStr, timezone },
    autoPublish: true,
  };
  if (networkType === "instagram") body.instagramData = { type: platformId === "igs" ? "STORY" : "REEL" };
  if (networkType === "facebook") body.facebookData = { type: platformId === "fbs" ? "STORY" : "REEL" };
  if (networkType === "tiktok") body.tiktokData = { privacyOption: "PUBLIC_TO_EVERYONE" };
  if (networkType === "youtube") body.youtubeData = { title: title || (text || "").slice(0, 100) || "Video", madeForKids: false };
  // Custom thumbnail (a specific frame the coach scrubbed to) — sent to every
  // platform's post body same as the ported dashboard did, not gated to
  // Instagram in code; Metricool/the platforms themselves ignore it where
  // it isn't supported (YouTube, Facebook), so there's no need to special-
  // case which networks get it here.
  if (thumbnailUrl) body.videoThumbnailUrl = thumbnailUrl;
  if (Number.isFinite(coverMilliseconds)) body.videoCoverMilliseconds = Math.max(0, Math.round(coverMilliseconds));
  return body;
}

// Uploads a JPEG thumbnail (base64, no data: prefix) to Metricool's own CDN
// via its 3-step S3 presigned-upload dance, then normalizes the resulting
// URL through Metricool's own image proxy (matches the ported dashboard's
// flow exactly) before handing back a URL usable in videoThumbnailUrl.
export async function uploadThumbnailToMetricool(auth, thumbnailBase64) {
  const { apiKey, userId, blogId } = auth;
  const { createHash } = await import("crypto");
  const thumbBuf = Buffer.from(thumbnailBase64, "base64");
  const thumbHash = createHash("sha256").update(thumbBuf).digest("base64");

  const txRes = await fetch(`${METRICOOL_BASE}/v2/media/s3/upload-transactions?userId=${userId}&blogId=${blogId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Mc-Auth": apiKey },
    body: JSON.stringify({
      resourceType: "planner", contentType: "image/jpeg", fileExtension: "jpg",
      parts: [{ size: thumbBuf.length, startByte: 0, endByte: thumbBuf.length, hash: thumbHash }],
    }),
  });
  if (!txRes.ok) throw new Error(`Metricool thumbnail upload-transaction failed: ${txRes.status} ${await txRes.text()}`);
  const txData = await txRes.json();
  const { presignedUrl, fileUrl } = txData.data || txData || {};
  if (!presignedUrl) throw new Error(`Metricool thumbnail: no presignedUrl returned (${JSON.stringify(txData).slice(0, 200)})`);

  const s3Res = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg", "x-amz-checksum-sha256": thumbHash },
    body: thumbBuf,
  });
  if (!s3Res.ok) throw new Error(`Metricool thumbnail S3 upload failed: ${s3Res.status}`);

  const completeRes = await fetch(`${METRICOOL_BASE}/v2/media/s3/upload-transactions?userId=${userId}&blogId=${blogId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Mc-Auth": apiKey },
    body: JSON.stringify({ simple: { fileUrl: fileUrl || presignedUrl.split("?")[0] } }),
  });
  if (!completeRes.ok) throw new Error(`Metricool thumbnail complete failed: ${completeRes.status} ${await completeRes.text()}`);
  const completeData = await completeRes.json();
  const thumbnailUrl = completeData.data?.convertedFileUrl || completeData.data?.fileUrl || null;
  if (!thumbnailUrl) throw new Error("Metricool thumbnail: no resulting URL after upload");

  try {
    const normRes = await fetch(`${METRICOOL_BASE}/actions/normalize/image/url?url=${encodeURIComponent(thumbnailUrl)}&folder=planner&userId=${userId}&blogId=${blogId}`, {
      headers: { "X-Mc-Auth": apiKey },
    });
    if (normRes.ok) {
      const normData = await normRes.json();
      const mcUrl = typeof normData === "string" ? normData : (normData?.data || normData?.url || normData?.result || null);
      if (mcUrl) return mcUrl;
    }
  } catch {}
  return thumbnailUrl;
}

// The actual publish call — NOT invoked anywhere in this file's own tests;
// only the favorite-modal's "Schedule to Powerbatics" button (a real coach
// clicking a real button) should ever call this in practice.
export async function schedulePost(auth, postBody) {
  const { apiKey, userId, blogId } = auth;
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
      const settings = getSocialVideoSettings();
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
      const current = getSocialVideoSettings();
      if (body.aiPrompt !== undefined) current.aiPrompt = String(body.aiPrompt).slice(0, 8000);
      if (body.ownWordsRatio !== undefined) current.ownWordsRatio = Math.max(0, Math.min(100, Number(body.ownWordsRatio) || 0));
      if (body.postHour !== undefined) current.postHour = Math.max(0, Math.min(23, Number(body.postHour) || 0));
      if (body.timezone !== undefined) current.timezone = String(body.timezone).slice(0, 100);
      if (body.platforms && typeof body.platforms === "object") {
        Object.keys(DEFAULT_PLATFORMS).forEach(k => {
          if (body.platforms[k] !== undefined) current.platforms[k] = !!body.platforms[k];
        });
      }
      writeJson(SETTINGS_FILE, current);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // Staff-only diagnostic — reports whether the credentials THIS RUNNING
  // PROCESS actually has loaded contain a non-Latin1 character (the class of
  // bug behind the recurring "Cannot convert argument to a ByteString"
  // publish failure), without ever exposing the secret values themselves.
  // Exists because local testing with the same-looking key values kept
  // passing while production kept failing identically — this checks the
  // live env directly instead of guessing from outside it.
  if (p === "/api/social-video/env-check" && req.method === "GET") {
    const names = ["METRICOOL_API_KEY", "METRICOOL_USER_ID", "METRICOOL_PB_BLOG_ID", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
    const report = names.map(name => {
      const value = process.env[name];
      if (!value) return { name, present: false };
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code > 255) return { name, present: true, ok: false, badIndex: i, badCharCode: code, length: value.length };
      }
      return { name, present: true, ok: true, length: value.length };
    });
    sendJson(res, 200, { report });
    return true;
  }

  // Caption generation only, no video/Drive/Metricool involved -- lets an
  // admin sanity-check what the brand voice prompt + own-words ratio +
  // voice bank actually produce for a given clip description before
  // trusting it on a real publish. Same generateCaptions() the real
  // pipeline calls, just fed a typed-in description instead of a real
  // clip's label.
  if (p === "/api/social-video/test-caption" && req.method === "POST") {
    const body = await readJsonBody(req);
    const description = String(body.description || "").trim().slice(0, 500);
    if (!description) return void sendJson(res, 400, { error: "description required" });
    try {
      const captions = await generateCaptions({ description });
      return void sendJson(res, 200, { captions });
    } catch (e) {
      return void sendJson(res, 500, { error: e.message });
    }
  }

  // The entire favorite-and-publish pipeline behind one call — a coach only
  // ever trims and labels a clip, everything else (tracking, vertical
  // reframe, captions, finding an open day, scheduling to every connected
  // platform) happens automatically here. Two Drive artifacts come out of
  // this: the trimmed clip in its ORIGINAL orientation, saved permanently
  // under the coach's label (this is "the favorite"), and a vertical
  // reframed copy that only exists long enough for Metricool to ingest it
  // before being deleted — Metricool copies the media into its own storage
  // on schedule (saveExternalMediaFiles:true in the post body), so nothing
  // is lost by discarding our temp copy afterward.
  if (p === "/api/social-video/save-and-publish" && req.method === "POST") {
    const body = await readJsonBody(req);
    // thumbnailBase64: a JPEG frame the coach scrubbed to before Save, already
    // cropped/scaled client-side to match what the reframed video will look
    // like. thumbnailTimeSec: that frame's timestamp in the ORIGINAL
    // (untrimmed) clip -- offset against trimStart below since the published
    // video starts at 0 there, same as the ported dashboard's
    // savedTime-startTime math.
    const { driveFileId, trimStart, trimEnd, label, videoWidth, videoHeight, keyframes, thumbnailBase64, thumbnailTimeSec, captions: reviewedCaptions } = body;
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
    const tmpVertical = join(tmpdir(), `sv_vert_${ts}.mp4`);
    let savedFileId = null, tempVerticalFileId = null;

    try {
      const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!dlRes.ok) throw new Error(`Drive download failed: ${dlRes.status}`);
      writeFileSync(tmpIn, Buffer.from(await dlRes.arrayBuffer()));

      // Trim — this is required, not optional, since the saved-to-Drive
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

      // Save the trimmed clip permanently — this must succeed before
      // anything else; if publishing fails downstream, the coach still has
      // their labeled clip safely in Drive either way.
      const cfg = readJson("chat_admin_config.json", {});
      const saveResult = await uploadStreamToDrive(createReadStream(tmpTrimmed), {
        name: label.trim().slice(0, 200) + ".mp4",
        mimeType: "video/mp4",
        folderId: cfg.favoritesFolderId || cfg.chatVideosFolderId,
        accessToken,
      });
      savedFileId = saveResult.id;
    } catch (e) {
      [tmpIn, tmpTrimmed, tmpVertical].forEach(f => { try { unlinkSync(f); } catch {} });
      return void sendJson(res, 500, { error: "Could not save clip: " + e.message });
    }

    // From here on, a failure still reports success on the save (already
    // done above) — publishing is best-effort on top of it.
    const publish = { published: false };
    try {
      reframeVideoVertical(tmpTrimmed, tmpVertical, {
        videoWidth: videoWidth || 1920, videoHeight: videoHeight || 1080,
        startTime: 0, keyframes,
      });
      const cfg = readJson("chat_admin_config.json", {});
      const vertResult = await uploadStreamToDrive(createReadStream(tmpVertical), {
        name: `POWERBATICS VERTICAL ${Date.now()}.mp4`,
        mimeType: "video/mp4",
        folderId: cfg.favoritesFolderId || cfg.chatVideosFolderId,
        accessToken,
      });
      tempVerticalFileId = vertResult.id;
      const publicMediaUrl = await makeDriveFilePublic(tempVerticalFileId, accessToken);

      const settings = getSocialVideoSettings();
      // The coach reviews/edits the AI draft in the UI before ever hitting
      // Send -- reviewedCaptions is that approved (possibly hand-edited)
      // version. Falls back to generating fresh only for a caller that
      // skips the review step entirely (there isn't one anymore, but this
      // keeps the route usable standalone).
      const captions = reviewedCaptions || await generateCaptions({ description: label.trim() });
      const auth = metricoolAuth(process.env.METRICOOL_PB_BLOG_ID);
      const accounts = await getConnectedAccounts(auth);

      let thumbnailUrl = null;
      if (thumbnailBase64) {
        try { thumbnailUrl = await uploadThumbnailToMetricool(auth, thumbnailBase64); }
        catch (e) { console.error("[save-and-publish] thumbnail upload failed, publishing without a custom one:", e.message); }
      }
      const coverMilliseconds = Number.isFinite(thumbnailTimeSec) ? (thumbnailTimeSec - (Number.isFinite(trimStart) ? trimStart : 0)) * 1000 : undefined;
      // "All available accounts" = every network this brand actually has
      // connected — plus the FB/IG Story variant riding along on the same
      // connected account, per Lee's explicit scoping decision to keep
      // FB/IG Stories in (only YouTube Community posts were dropped) --
      // filtered further by which of those an admin has actually left
      // enabled in settings.platforms.
      const networkToPlatform = { facebook: "fb", instagram: "ig", youtube: "yt", tiktok: "tt", linkedin: "li", twitter: "x" };
      const storyPlatform = { facebook: "fbs", instagram: "igs" };
      const platformIds = Object.entries(accounts).filter(([, id]) => !!id)
        .flatMap(([net]) => [networkToPlatform[net], storyPlatform[net]].filter(Boolean))
        .filter(id => settings.platforms[id]);

      const day = await findNextOpenDay(auth, { timezone: settings.timezone });
      if (!day) throw new Error("Could not find an open day to schedule on");
      const hour = String(Math.max(0, Math.min(23, Number(settings.postHour) || 0))).padStart(2, "0");
      const dateTimeStr = `${day}T${hour}:00:00`;

      const results = [];
      for (const platformId of platformIds) {
        const accountId = accounts[NETWORK_TYPE_MAP[platformId]];
        // Stories reuse their parent platform's caption — CAPTION_PLATFORMS
        // has no separate fbs/igs entry (a Story doesn't need its own).
        const captionKey = platformId === "fbs" ? "fb" : platformId === "igs" ? "ig" : platformId;
        const plat = captions[captionKey] || {};
        const postBody = buildMetricoolPostBody({ platformId, accountId, text: plat.desc, title: plat.title, mediaUrl: publicMediaUrl, dateTimeStr, timezone: settings.timezone, thumbnailUrl, coverMilliseconds });
        try {
          await schedulePost(auth, postBody);
          results.push({ platformId, ok: true });
        } catch (e) {
          results.push({ platformId, ok: false, error: e.message });
        }
      }
      publish.published = true;
      publish.scheduledDay = day;
      publish.results = results;
    } catch (e) {
      publish.error = e.message;
      // No stack trace was being logged for this — meant every failure here
      // (like the ByteString/header-encoding bug) surfaced only as a bare
      // message with no way to tell which call inside this block threw it.
      console.error("[save-and-publish] publish step failed:", e.stack || e);
    } finally {
      [tmpIn, tmpTrimmed, tmpVertical].forEach(f => { try { unlinkSync(f); } catch {} });
      // Discard the vertical copy regardless of how far publishing got —
      // Metricool already has its own copy of anything it successfully
      // ingested, and a half-published temp file has no other use.
      if (tempVerticalFileId) {
        try {
          const delToken = await getDriveAccessToken();
          await fetch(`https://www.googleapis.com/drive/v3/files/${tempVerticalFileId}`, { method: "DELETE", headers: { Authorization: `Bearer ${delToken}` } });
        } catch (e) { console.error("[save-and-publish] couldn't discard temp vertical file:", e.message); }
      }
    }

    sendJson(res, 200, { savedFileId, ...publish });
    return true;
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}
