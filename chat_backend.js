// chat_backend.js — WhatsApp-style chat: auth, users, conversations, messages,
// Drive-backed media (upload + streaming proxy), push notifications.
// Mounted from server.js: handleChatRequest(req, res, url) returns true if it
// handled the request, false to let server.js's existing routing continue.

import { readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { request as httpsRequest } from "https";
import { execFileSync } from "child_process";
import { Readable } from "stream";
import Busboy from "busboy";
import webPush from "web-push";
// firebase-admin v14 is fully modular now — no admin.credential.cert(...)
// or admin.messaging(app) namespace like older versions/most tutorials
// still show; cert/initializeApp live directly on the default export,
// and messaging needs its own subpath import.
import admin from "firebase-admin";
import { getMessaging } from "firebase-admin/messaging";
import { JSDOM } from "jsdom";
import ffmpegPath from "ffmpeg-static";
import { sendApnsPush, apnsConfigured } from "./apns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USERS_FILE = "chat_users.json";
const SESSIONS_FILE = "chat_sessions.json";
const CONVOS_FILE = "chat_conversations.json";
const MESSAGES_FILE = "chat_messages.json";
const PUSH_FILE = "chat_push_subscriptions.json";
const CONFIG_FILE = "chat_admin_config.json";
const RESETS_FILE = "chat_password_resets.json";
const UPLOAD_COUNTERS_FILE = "chat_upload_counters.json";
const TRAINING_PROTOCOLS_FILE = "chat_training_protocols.json";
const FAVORITES_FILE = "chat_favorites.json";
const BLOCKS_FILE = "chat_blocks.json";
const REPORTS_FILE = "chat_reports.json";
const MESSAGE_TEMPLATES_FILE = "chat_message_templates.json";
const PROTOCOL_STEP_TEMPLATES_FILE = "chat_protocol_step_templates.json";
// Whole reusable protocols (named, full step graph) a coach can apply to
// any student — distinct from PROTOCOL_STEP_TEMPLATES_FILE above, which is
// just individual saved text snippets for a single step.
const PROTOCOL_TEMPLATES_FILE = "chat_protocol_templates.json";
// Kickoff/intake form a client fills out once (locked immediately after);
// only staff can unlock it for another round of edits. Keyed by target
// user id, same shape as TRAINING_PROTOCOLS_FILE above.
const INTAKE_FORMS_FILE = "chat_intake_forms.json";
// Free-form coach/admin notes per client — never visible to the client,
// separate from both the intake form and the chat history itself.
const NOTES_FILE = "chat_notes.json";
const GYM_BLOCKED_DATES_FILE = "chat_gym_blocked_dates.json";
const CALLS_FILE = "chat_calls.json";

const APP_SHEET_ID = "1SQPcRayDql4Fe4BJ5kcHUczMzJGCocy6jAblt3hPplI";
const APP_SHEET_TAB = "APP";

// Gym + Online skill-level tracking — same six categories in both tabs
// (FOUNDATION is pass/fail, the rest are numeric levels), tracked in two
// separate tabs of one spreadsheet since gym and online are run as
// separate rosters. Combined client-side into one searchable list.
const LEVELS_SHEET_ID = "1N3HCeHkt6ELLonZ2u2RbV-8x43UM9VWvGaNVNvGZIA0";
const LEVELS_CATEGORIES = ["FOUNDATION", "NINJA STRENGTH", "HANDSTAND", "POWERMOVES", "FREERUN", "CIRQUE"];

// Railway rebuilds the container from a fresh git checkout on every deploy —
// without a mounted Volume, these data files would live at __dirname
// alongside the code and get reset to whatever's committed in git on every
// deploy, silently reverting any admin/user action taken since the last
// commit (renames, role changes, deletions, new messages, everything).
// RAILWAY_VOLUME_MOUNT_PATH is set automatically once a Volume is attached
// to this service in the Railway dashboard; falls back to __dirname (the
// old, non-persistent behavior) if none is attached yet.
export const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

// One-time seed: the first boot after a Volume is attached, its mount dir is
// empty — copy each file's last git-committed version over as a starting
// point so existing users/conversations/etc. aren't wiped by the switch.
// No-ops on every boot after that (dest already exists), and no-ops entirely
// if no Volume is attached (DATA_DIR === __dirname, dest === seed).
function migrateDataFile(file) {
  const dest = join(DATA_DIR, file);
  const seed = join(__dirname, file);
  if (dest !== seed && !existsSync(dest) && existsSync(seed)) {
    // writeFileSync does NOT create intermediate directories — for a
    // nested path (e.g. "personality-quiz/leads.json") on a freshly
    // attached Volume that's never held anything but flat files before,
    // this threw ENOENT synchronously at module-load time, before the
    // server ever started listening, which took the whole app down
    // ("Application failed to respond") rather than failing one request.
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(seed));
  }
}
[
  "chat_users.json", "chat_sessions.json", "chat_conversations.json", "chat_messages.json",
  "chat_push_subscriptions.json", "chat_admin_config.json", "chat_password_resets.json",
  "chat_upload_counters.json", "chat_training_protocols.json", "chat_favorites.json",
  "chat_appointments.json", "chat_message_templates.json", "chat_protocol_step_templates.json",
  "chat_gym_blocked_dates.json", "chat_calls.json", "chat_body_scans.json", "personality-quiz/leads.json", "personality-quiz/config.json",
// Defensive: this runs at module-load time, before the server starts
// listening — one bad seed here must never take the whole app down again
// the way the missing-mkdirSync bug above just did in production.
].forEach(file => { try { migrateDataFile(file); } catch (e) { console.error("[migrateDataFile]", file, e.message); } });

export function readJson(file, fallback) {
  const p = join(DATA_DIR, file);
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback; } catch { return fallback; }
}
export function writeJson(file, data) {
  const dest = join(DATA_DIR, file);
  // Same nested-path issue as migrateDataFile above, just at request time
  // instead of boot time — a first-ever write for a nested file (e.g.
  // personality-quiz/leads.json) on a fresh Volume needs its subdirectory
  // created before the file itself can be.
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(data, null, 2), "utf8");
}

// One-time role rename: "student" -> "online" (the "gym" role is new
// alongside it, not a rename target — existing gym-program clients were
// never called "student" in this system). Runs on every boot but only ever
// writes once, since after the first pass no account is left at "student".
(function migrateStudentRoleToOnline() {
  const users = readJson(USERS_FILE, []);
  let changed = false;
  users.forEach(u => { if (u.role === "student") { u.role = "online"; changed = true; } });
  if (changed) writeJson(USERS_FILE, users);
})();

// Static, bundled-with-code content that has no write path anywhere in this
// file — always read from the app's own directory, never the Volume. Kept
// for personality-quiz/config.json's other tabs (questions/settings) if
// anything ever reads those without going through readJson; config.json and
// leads.json themselves are now regular DATA_DIR-routed data files (see
// migrateDataFile's list above) since /api/personality-quiz/config and
// /lead both have real write paths in this file now.
function readAppJson(file, fallback) {
  const p = join(__dirname, file);
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback; } catch { return fallback; }
}

// Admin settings fields for a Drive folder are documented as "the ID", but
// the natural thing to paste is the full folder URL from the address bar —
// normalizing here (the one place config gets read) means every endpoint
// that uses these gets a bare ID regardless of which form was saved.
function extractDriveFolderId(value) {
  const v = String(value || "").trim();
  const m = v.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : v;
}

const DEFAULT_APPOINTMENTS_CONFIG = {
  defaultDurationMinutes: 15,
  timezone: "America/Anchorage",
  // The Google Calendar ID/email for the shared "GYM 90 MINUTE TRAINING
  // BLOCK" calendar -- Gym self-serve bookings are created directly on this
  // calendar (with the client as an attendee, so it also lands on their own
  // calendar via the invite), not on an individual coach's calendar.
  gymCalendarId: "",
  emailEnabled: true,
  emailSubjectTemplate: "Your upcoming session with {{coachName}} — {{date}} at {{time}}",
  emailBodyTemplate: "Hi {{firstName}},<br><br>Your training session with {{coachName}} is confirmed for <strong>{{date}} at {{time}}</strong> ({{duration}} min).<br><br>See you then!",
  smsEnabled: true,
  smsTemplate: "Hi {{firstName}}, your session with {{coachName}} is confirmed for {{date}} at {{time}} ({{duration}} min).",
  // Reminders are separate from the confirmation sent at booking time — each
  // channel gets its own independent lead-time list (e.g. email 24h+1h
  // before, SMS just 1h before), since the two channels are read on very
  // different timelines.
  emailRemindersEnabled: true,
  emailReminderMinutesBefore: [1440, 60],
  emailReminderUsesInitialTemplate: false,
  emailReminderSubjectTemplate: "Reminder: your session with {{coachName}} is coming up",
  emailReminderBodyTemplate: "Hi {{firstName}},<br><br>Just a reminder — your training session with {{coachName}} is <strong>{{date}} at {{time}}</strong> ({{duration}} min).<br><br>See you soon!",
  smsRemindersEnabled: true,
  smsReminderMinutesBefore: [60],
  smsReminderUsesInitialTemplate: false,
  smsReminderTemplate: "Reminder: your session with {{coachName}} is {{date}} at {{time}} ({{duration}} min).",
  // "Messenger" reminders post into the chat thread itself (plus a push
  // notification) instead of going out over email/SMS. The default option
  // re-posts the same rich appointment bubble (calendar icon, date/time,
  // Add to Calendar / Join Zoom links) used for the original booking
  // confirmation, rather than a plain templated line of text.
  messengerRemindersEnabled: true,
  messengerReminderMinutesBefore: [60],
  messengerReminderUseDefault: true,
  messengerReminderTemplate: "Reminder: your session with {{coachName}} is {{date}} at {{time}} ({{duration}} min).",
};

export function getConfig() {
  const cfg = readJson(CONFIG_FILE, {
    profilePhotosFolderId: "", chatImagesFolderId: "", chatVideosFolderId: "",
    trainingProtocolFolderId: "",
    // Distinct from trainingProtocolFolderId (which is where NEW coach uploads
    // get saved) — this is the existing video library the "Choose a Video"
    // picker searches (currently "3. INSTRUCTIONAL INCLUDES STUDENTS", which
    // itself has STUDIO/COURSES/KATAS subfolders that must be searched too).
    trainingProtocolVideoLibraryFolderId: "15dt68-wgb_BVoUw0dmlimBQFcwVf6KTX",
    // Where the raw source footage for the Powerbatics Training Videos
    // catalog (moves_dictionary.json, moves_dictionary_backend.js) lives —
    // that catalog is hand-curated (each entry has its own driveFileId
    // plus name/description/category/tags a folder scan can't produce), so
    // this isn't live-scanned to build the list; it's the reference folder
    // an admin pulls new clips from when adding a move by hand.
    powerbaticsVideosFolderId: "1Es9fbvFRx7EuFiZu9t-X8pmZXGigf_wX",
    // Where a coach's starred chat photos/videos get copied — see
    // favoriteMedia() below. Must be a regular "My Drive" folder (owned by
    // the same account as GOOGLE_REFRESH_TOKEN_PRA), not a Shared Drive
    // folder: ownership transfer to the coach only makes sense for a file
    // an individual account actually owns.
    favoritesFolderId: "",
    // Each kickoff/intake submission gets its OWN new doc here (a locked
    // snapshot in time); each client gets exactly ONE doc here that every
    // note save prepends to (a running log) — see the intake/notes
    // endpoints and createOrUpdateDriveDoc below.
    intakeFormsFolderId: "1He6NLZU0g9YNiG87C8Vhn2AKfrT6Cz-j",
    clientNotesFolderId: "1fOczxxstyKr9oaBnDvo4cDRhpgl_CWxG",
    // Where finished video-call recordings get archived once Daily reports
    // them ready — see archiveCallRecording().
    callRecordingsFolderId: "",
    // Physique Builder (body_analysis_backend.js/body_stats_backend.js/
    // food_log_backend.js) -- was hardcoded per-file before this setting
    // existed; bodyScanPhotosFolderId also backs the standalone "progress
    // photo" quick-add (same category of photo, one folder for both).
    bodyScanPhotosFolderId: "1Da9BVFV5N8vRAEJiPHOSyabGkNPnUhqw",
    nutritionPhotosFolderId: "",
    gifApiKey: "", vapidPublicKey: "", vapidPrivateKey: "",
    appointments: { ...DEFAULT_APPOINTMENTS_CONFIG },
  });
  ["profilePhotosFolderId", "chatImagesFolderId", "chatVideosFolderId", "trainingProtocolFolderId", "trainingProtocolVideoLibraryFolderId", "powerbaticsVideosFolderId", "favoritesFolderId", "intakeFormsFolderId", "clientNotesFolderId", "callRecordingsFolderId", "bodyScanPhotosFolderId", "nutritionPhotosFolderId"].forEach(k => {
    if (cfg[k]) cfg[k] = extractDriveFolderId(cfg[k]);
  });
  if (!cfg.trainingProtocolVideoLibraryFolderId) cfg.trainingProtocolVideoLibraryFolderId = "15dt68-wgb_BVoUw0dmlimBQFcwVf6KTX";
  if (!cfg.powerbaticsVideosFolderId) cfg.powerbaticsVideosFolderId = "1Es9fbvFRx7EuFiZu9t-X8pmZXGigf_wX";
  if (!cfg.intakeFormsFolderId) cfg.intakeFormsFolderId = "1He6NLZU0g9YNiG87C8Vhn2AKfrT6Cz-j";
  if (!cfg.clientNotesFolderId) cfg.clientNotesFolderId = "1fOczxxstyKr9oaBnDvo4cDRhpgl_CWxG";
  if (!cfg.bodyScanPhotosFolderId) cfg.bodyScanPhotosFolderId = "1Da9BVFV5N8vRAEJiPHOSyabGkNPnUhqw";
  // No non-empty default to fall back to (unlike the ones above) — just
  // ensures the key exists on configs saved before this feature existed, so
  // it isn't silently `undefined` and shows up as an empty field in the
  // admin panel rather than never appearing in the response at all.
  if (cfg.favoritesFolderId === undefined) cfg.favoritesFolderId = "";
  if (cfg.callRecordingsFolderId === undefined) cfg.callRecordingsFolderId = "";
  if (cfg.nutritionPhotosFolderId === undefined) cfg.nutritionPhotosFolderId = "";
  // Merge in any new default appointment fields for configs saved before this feature existed.
  cfg.appointments = { ...DEFAULT_APPOINTMENTS_CONFIG, ...(cfg.appointments || {}) };
  return cfg;
}

// Per-user, per-upload-kind sequence numbers, so re-uploads from the same
// person are individually identifiable in Drive (e.g. "John Smith 2.png")
// instead of silently overwriting/looking identical to "John Smith 1.png".
function nextUploadNumber(userId, kind) {
  const counters = readJson(UPLOAD_COUNTERS_FILE, {});
  if (!counters[userId]) counters[userId] = {};
  const n = (counters[userId][kind] || 0) + 1;
  counters[userId][kind] = n;
  writeJson(UPLOAD_COUNTERS_FILE, counters);
  return n;
}

const MIME_EXT = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-msvideo": ".avi",
};
function extFromMime(mimeType, originalName) {
  if (MIME_EXT[mimeType]) return MIME_EXT[mimeType];
  const match = /\.[a-zA-Z0-9]+$/.exec(originalName || "");
  return match ? match[0] : "";
}
function saveConfig(cfg) { writeJson(CONFIG_FILE, cfg); }

// Ensure VAPID keys exist (generated once, persisted)
function ensureVapidKeys() {
  const cfg = getConfig();
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) {
    const keys = webPush.generateVAPIDKeys();
    cfg.vapidPublicKey = keys.publicKey;
    cfg.vapidPrivateKey = keys.privateKey;
    saveConfig(cfg);
  }
  webPush.setVapidDetails("mailto:lee@pacificrimathletics.com", cfg.vapidPublicKey, cfg.vapidPrivateKey);
  return cfg;
}

// ── Password hashing (Node built-in scrypt, no native deps) ────────────────
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(check, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicUser(u) {
  if (!u) return null;
  // ip/geo are precise personal data (home/work location) — never exposed
  // through the general user-info shape other logged-in users can see via
  // contacts/conversations. The users-map endpoint exposes a deliberately
  // narrower view (first name + coarse lat/lng only) separately below.
  const { passwordHash, passwordSalt, ip, geo, ...rest } = u;
  return rest;
}

// ── Sessions ─────────────────────────────────────────────────────────────
function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const match = header.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
function createSession(userId) {
  const sessions = readJson(SESSIONS_FILE, {});
  const token = randomBytes(32).toString("hex");
  sessions[token] = { userId, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
  writeJson(SESSIONS_FILE, sessions);
  return token;
}
function destroySession(token) {
  const sessions = readJson(SESSIONS_FILE, {});
  delete sessions[token];
  writeJson(SESSIONS_FILE, sessions);
}
export function getSessionUser(req) {
  const token = getCookie(req, "pra_session");
  if (!token) return null;
  const sessions = readJson(SESSIONS_FILE, {});
  const session = sessions[token];
  if (!session || session.expiresAt < Date.now()) return null;
  const users = readJson(USERS_FILE, []);
  const found = users.find(u => u.id === session.userId) || null;
  // Archiving revokes access immediately, not just future logins — an
  // already-open session for a now-archived user shouldn't keep working.
  if (found?.archived) return null;
  return found;
}
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `pra_session=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
}

// ── JSON body helper ─────────────────────────────────────────────────────
export function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}
export function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
  return true; // signals "handled" to the caller's fall-through check
}

// ── Google OAuth (Drive read/write) ─────────────────────────────────────
// Cached (Google's own expires_in, minus a 5-minute safety margin) instead
// of exchanging a fresh token on every single call — this token also backs
// the Range-aware video/image streaming proxy, where a single video being
// watched or scrubbed triggers many separate requests in quick succession.
// Without caching, EACH of those paid for a full token-exchange round trip
// before the actual Drive fetch even started, which is exactly what showed
// up as a video that looks like it's perpetually loading/re-buffering.
let driveTokenCache = null; // { token, expiresAt }
export async function getDriveAccessToken() {
  if (driveTokenCache && driveTokenCache.expiresAt > Date.now()) return driveTokenCache.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN_PRA,
      grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Google token refresh failed: " + JSON.stringify(d));
  const ttlMs = ((d.expires_in || 3600) - 300) * 1000; // 5-minute safety margin
  driveTokenCache = { token: d.access_token, expiresAt: Date.now() + ttlMs };
  return d.access_token;
}
// Same token also covers Sheets + Gmail scopes — reused for both below.
const getGoogleAccessToken = getDriveAccessToken;

// Range-aware Drive file streaming, shared by every authorized media-read
// route (this file's own chat-media proxy below, plus body_stats_backend.js's
// progress-photo proxy) -- each route does its OWN authorization check
// first (this fileId belongs to something the requester can see), then
// hands off to this once that's settled.
export async function streamDriveMedia(req, res, fileId, accessToken) {
  await new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (req.headers.range) headers.Range = req.headers.range;
    const driveReq = httpsRequest({
      hostname: "www.googleapis.com",
      path: `/drive/v3/files/${fileId}?alt=media`,
      method: "GET",
      headers,
    }, driveRes => {
      const passHeaders = {};
      ["content-type", "content-length", "content-range", "accept-ranges"].forEach(h => {
        if (driveRes.headers[h]) passHeaders[h.replace(/(^|-)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase())] = driveRes.headers[h];
      });
      // A given fileId's bytes never change once sent -- nothing here ever
      // needs revalidating. `private` (not `public`) since access is gated
      // per-request by the caller -- this is safe to keep on THIS device's
      // cache, not a shared one.
      passHeaders["Cache-Control"] = "private, max-age=31536000, immutable";
      res.writeHead(driveRes.statusCode, passHeaders);
      driveRes.pipe(res);
      driveRes.on("end", resolve);
    });
    driveReq.on("error", reject);
    driveReq.end();
  });
}

// ── Video calls (Daily.co) ──────────────────────────────────────────────
// Thin REST wrapper — no SDK installed for this, same "hand-rolled fetch
// against the documented REST endpoint" approach as the Drive/Sheets calls
// above rather than pulling in another dependency for a handful of calls.
const DAILY_API_BASE = "https://api.daily.co/v1";
async function dailyApiRequest(path, method, body) {
  const r = await fetch(DAILY_API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Daily API ${method} ${path} failed: ${r.status} ${JSON.stringify(d)}`);
  return d;
}
// Private room, auto-expires a couple hours after creation so an
// abandoned/never-answered call doesn't linger on the account forever —
// harmless either way (Daily bills active call-minutes, not idle rooms),
// this is just hygiene.
async function createDailyRoom(name) {
  const exp = Math.floor(Date.now() / 1000) + 2 * 3600;
  return dailyApiRequest("/rooms", "POST", {
    name, privacy: "private",
    properties: { exp, eject_at_room_exp: true, enable_chat: false, enable_screenshare: true, enable_recording: "cloud" },
  });
}
// Per-participant, short-lived credential that actually grants entry to a
// private room — the Daily API key itself never reaches the client, only
// this scoped token does. is_owner grants Daily's recording-control
// permission -- only the call's initiator gets it (see /call/start and the
// accept handler below), and only they trigger startRecording/
// stopRecording client-side, so exactly one side manages the recording's
// lifecycle instead of both sides racing to start/stop it.
async function createDailyMeetingToken(roomName, userId, userName, isOwner) {
  const exp = Math.floor(Date.now() / 1000) + 2 * 3600;
  const d = await dailyApiRequest("/meeting-tokens", "POST", {
    properties: { room_name: roomName, user_id: userId, user_name: userName, is_owner: !!isOwner, exp },
  });
  return d.token;
}
async function listDailyRecordings(roomName) {
  const d = await dailyApiRequest(`/recordings?room_name=${encodeURIComponent(roomName)}`, "GET");
  return d.data || [];
}
async function getDailyRecordingAccessLink(recordingId) {
  const d = await dailyApiRequest(`/recordings/${recordingId}/access-link`, "GET");
  return d.download_link;
}
async function deleteDailyRecording(recordingId) {
  return dailyApiRequest(`/recordings/${recordingId}`, "DELETE");
}

// Chat-account role -> the App sheet's own TYPE column vocabulary (see the
// "prefix match" comment on sheetRole in fetchUsersMapPoints — Admin 2
// still glows blue there because it starts with "admin").
function roleToSheetType(role) {
  if (role === "admin") return "Admin";
  if (role === "admin2") return "Admin 2";
  if (role === "coach") return "Coach";
  if (role === "online" || role === "gym") return "Student";
  return "User";
}

// Append-or-update a signup's row in the shared "APP" tracking sheet, matched by
// email. Never allowed to break signup/reset flows — callers swallow its errors.
// `role`, if passed, also writes column J (TYPE) so a manually-created
// account or a role change shows up correctly on the Strength Ninjas map —
// omitted for the plain signup/reset-password callers below, which leave
// TYPE for the business to set by hand same as always.
async function upsertAppSheetRow({ first, last, email, phone, ip, location, role }) {
  const accessToken = await getGoogleAccessToken();
  const range = `'${APP_SHEET_TAB}'!A:F`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && (r[2] || "").toLowerCase() === email.toLowerCase());
  const rowValues = [[first, last, email, phone || "", ip || "", location || ""]];
  const type = role ? roleToSheetType(role) : undefined;

  if (rowIndex > 0) {
    const sheetRow = rowIndex + 1; // 1-indexed
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!A${sheetRow}:F${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: rowValues }),
      }
    );
    if (type) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!J${sheetRow}`)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[type]] }),
        }
      );
    }
  } else {
    // New row: A-F as before, then G/H/I (personality) left blank and J
    // (TYPE) filled in if a role was given — matches the column layout
    // updatePersonalityColumn() uses for its own append below.
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!A1:J1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[first, last, email, phone || "", ip || "", location || "", "", "", "", type || ""]] }),
      }
    );
  }
}

// Role-only sync — used when an existing account's role changes. Deliberately
// separate from upsertAppSheetRow: that one always rewrites A-F (contact
// info) too, which would blank out an existing row's IP/location on every
// role change. This only ever touches column J, and only writes A-F (via a
// full-row append) for the fallback case where the person has no row yet.
async function syncAppSheetRole(targetUser) {
  const accessToken = await getGoogleAccessToken();
  const range = `'${APP_SHEET_TAB}'!A:F`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && (r[2] || "").toLowerCase() === (targetUser.email || "").toLowerCase());
  const type = roleToSheetType(targetUser.role);

  if (rowIndex > 0) {
    const sheetRow = rowIndex + 1;
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!J${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[type]] }),
      }
    );
  } else {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!A1:J1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[targetUser.first, targetUser.last, targetUser.email, targetUser.phone || "", "", "", "", "", "", type]] }),
      }
    );
  }
}

// Writes G (MEYERS BRIGGS), H (16 P), I (PRA PERSONA), K (GENDER) for the row
// matching this email — never touches A-F or J (TYPE). Appends a new row if
// the email has no existing row.
export async function updatePersonalityColumn(email, mbti, standard, archetype, gender, first, last) {
  const accessToken = await getGoogleAccessToken();
  const range = `'${APP_SHEET_TAB}'!A:K`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && (r[2] || "").toLowerCase() === (email || "").toLowerCase());

  if (rowIndex > 0) {
    const sheetRow = rowIndex + 1;
    // Write archetype columns G:I (skip J=TYPE), then gender in K separately
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!G${sheetRow}:I${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[mbti || "", standard || "", archetype || ""]] }),
      }
    );
    if (gender) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!K${sheetRow}`)}?valueInputOption=USER_ENTERED`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [[gender]] }),
        }
      );
    }
  } else {
    // New row: A B C D E F G H I J(TYPE blank) K
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!A1:K1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[first || "", last || "", email || "", "", "", "", mbti || "", standard || "", archetype || "", "", gender || ""]] }),
      }
    );
  }
}

// Best-effort client IP extraction — X-Forwarded-For (first hop, for if this
// ever sits behind a proxy) falling back to the raw socket address.
function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "";
}

// Free IP geolocation (ip-api.com, no key required at this volume). Returns
// null for loopback/private/local addresses — there's nothing to geolocate
// on a dev machine, and the caller treats a null return as "skip silently."
async function geolocateIp(ip) {
  if (!ip || ip === "::1" || ip === "127.0.0.1" || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) {
    return null;
  }
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country,lat,lon`);
    const d = await r.json();
    if (d.status !== "success") return null;
    return { city: d.city, region: d.regionName, country: d.country, lat: d.lat, lng: d.lon };
  } catch {
    return null;
  }
}

// In-memory cache so opening the map repeatedly doesn't re-hit ip-api.com's
// free-tier rate limit for the same IP — an IP's geolocation doesn't change
// minute to minute, only the SHEET DATA (who's in it, their IP) needs to be
// re-read fresh on every open, which fetchUsersMapPoints() below always does.
const geoCache = new Map(); // ip -> { geo, expiresAt }
async function geolocateIpCached(ip) {
  const cached = geoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.geo;
  const geo = await geolocateIp(ip);
  geoCache.set(ip, { geo, expiresAt: Date.now() + 6 * 3600 * 1000 });
  return geo;
}

// Text geocoding (Nominatim/OpenStreetMap, free, no key) — the fallback for
// rows that have a LOCATION string but no IP, e.g. hand-entered before the
// automatic IP capture existed, or edited directly in the sheet. Nominatim's
// usage policy caps free use at ~1 req/sec and requires an identifying
// User-Agent, so results are cached and lookups are serialized below.
const geocodeCache = new Map(); // locationText -> { geo, expiresAt }
async function geocodeLocationTextCached(text) {
  if (!text) return null;
  const cached = geocodeCache.get(text);
  if (cached && cached.expiresAt > Date.now()) return cached.geo;
  let geo = null;
  try {
    // addressdetails=1 gets Nominatim's own structured city/state/country
    // breakdown, rather than guessing it back out of the input text by
    // splitting on commas — the input might be "City, State" with no
    // country at all, and naive splitting would wrongly duplicate the
    // state into the country field.
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(text)}`, {
      headers: { "User-Agent": "PRA-Chat-UsersMap/1.0 (lee@pacificrimathletics.com)" },
    });
    const d = await r.json();
    if (d[0]) {
      const a = d[0].address || {};
      geo = {
        lat: Number(d[0].lat), lng: Number(d[0].lon),
        city: a.city || a.town || a.village || a.county || "",
        region: a.state || a.region || "",
        country: a.country || "",
      };
    }
  } catch { /* geo stays null */ }
  geocodeCache.set(text, { geo, expiresAt: Date.now() + 24 * 3600 * 1000 });
  return geo;
}

// Always reads the APP sheet fresh (never a local cache) so the map reflects
// whatever's currently in the spreadsheet, including hand-edited rows.
// Most recent quiz result for this email, if any — leads.json is unshift'd
// on each new submission (newest first), so the first match is the latest.
function getLatestArchetypeImage(email) {
  if (!email) return null;
  const leads = readJson("personality-quiz/leads.json", []);
  const lead = leads.find(l => (l.email || "").toLowerCase() === email.toLowerCase());
  return lead?.image || null;
}

// Build lookups from MBTI code, PRA title, and 16P standard name → {male, female} image URLs.
// All keys are normalized for case-insensitive matching.
function buildArchetypeImageMaps() {
  const cfg = readJson("personality-quiz/config.json", {});
  const byCode = {}, byTitle = {}, byStandard = {};
  for (const [code, arch] of Object.entries(cfg.archetypes || {})) {
    if (!arch.images) continue;
    const entry = { title: arch.title || null, male: arch.images.male || null, female: arch.images.female || arch.images.male || null };
    byCode[code.toUpperCase()] = entry;
    const t = (arch.title || "").toLowerCase();
    const s = (arch.standard || "").toLowerCase();
    if (t) byTitle[t] = entry;
    if (s) byStandard[s] = entry;
  }
  return { byCode, byTitle, byStandard };
}

async function fetchUsersMapPoints() {
  const accessToken = await getGoogleAccessToken();
  // Read through column K: MBTI (G), 16P (H), PRA PERSONA (I), TYPE (J), GENDER (K)
  const range = `'${APP_SHEET_TAB}'!A:K`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await r.json();
  const rows = (data.values || []).slice(1); // drop header
  const localUsers = readJson(USERS_FILE, []);
  const levelsPeople = await fetchAllLevels().catch(() => []);
  const archetypeMaps = buildArchetypeImageMaps();

  const points = [];
  for (const row of rows) {
    const [first, last, email, , ip, location, mbtiCode, sheetPersona16p, praPersona, sheetType, sheetGender] = row;
    if (!first) continue;
    const localUser = localUsers.find(u => u.email.toLowerCase() === (email || "").toLowerCase());
    if (localUser?.archived) continue;
    let geo = localUser?.locationOverride || (ip ? await geolocateIpCached(ip) : null);
    if (!geo && location) geo = await geocodeLocationTextCached(location);
    if (!geo) continue;

    // Sheet column I (PRA PERSONA title) is the authoritative source; fall back
    // to MBTI code (col G), 16P name (col H), then the latest quiz image.
    // Gender: a local override (chat_users.json) wins — it's the one place
    // an admin can correct it without waiting for someone to retake the quiz
    // — then whatever the sheet captured when the quiz was completed (col J),
    // then "male" as a last resort when neither is known.
    const gender = localUser?.gender || (sheetGender || "").toLowerCase() || "male";
    const pick = entry => entry ? (entry[gender] || entry.male || null) : null;
    const matchedArchetype =
      archetypeMaps.byTitle[(praPersona || "").toLowerCase()] ||
      archetypeMaps.byCode[(mbtiCode || "").toUpperCase()] ||
      archetypeMaps.byStandard[(sheetPersona16p || "").toLowerCase()] ||
      null;
    const archetypeImage = pick(matchedArchetype) || getLatestArchetypeImage(email) || null;
    const archetypeTitle = matchedArchetype?.title || null;

    // The sheet's own TYPE column (Admin/Coach/Student/User) is authoritative
    // for the map — every point here already comes from a matched sheet row
    // (this loop iterates sheet rows, not chat accounts), so that row's own
    // TYPE reflects how the business actually classifies them. A chat
    // account's internal role governs app permissions, not this — falling
    // back to it made a blank TYPE silently inherit whatever role a test/dev
    // account happened to have (e.g. a real "Student" row rendered white
    // because it had no chat account, while a blank-TYPE test account with
    // role="student" set on its chat account rendered green). Blank/
    // unrecognized TYPE just means "no special classification" (plain
    // default glow), not "go look somewhere else."
    // Matched by prefix, not exact equality — the sheet has entries like
    // "Admin 2 (no panel access)" that are still clearly an Admin row, just
    // with a parenthetical note attached. An exact match silently dropped
    // those to the default white glow instead of blue.
    const normalizedSheetType = (sheetType || "").trim().toLowerCase();
    const sheetRole = ["admin", "coach", "student", "user"].find(r => normalizedSheetType.startsWith(r)) || null;

    points.push({
      first,
      // Only ever sent to a staff viewer (stripped in the /api/chat/users-map
      // handler for anyone else, same as levels below) — needed to target
      // the right person when a coach/admin edits levels from the map
      // popup, via the name-matched /api/chat/levels/update endpoint.
      last,
      profilePictureFileId: localUser?.profilePictureFileId || null,
      archetypeImage,
      archetypeTitle,
      gender,
      role: sheetRole || "user",
      lat: geo.lat, lng: geo.lng,
      city: geo.city, region: geo.region, country: geo.country,
      levels: findLevelsEntries(levelsPeople, first, last),
    });
  }
  return points;
}

// Same App-sheet row matching as fetchUsersMapPoints() above, but for one
// specific chat account by name instead of every geolocatable sheet row —
// used by the chat sidebar's read-only profile popup. Includes levels (same
// as the map/levels endpoints, visible to everyone) and doesn't require a
// geo match to succeed — a person with no location on the sheet still gets
// a profile card, just without a location line.
async function fetchUserProfileCard(targetUser) {
  const card = {
    first: targetUser.first, last: targetUser.last, role: targetUser.role,
    profilePictureFileId: targetUser.profilePictureFileId || null,
    location: null, archetypeImage: null, archetypeTitle: null, gender: null, levels: [],
  };
  const levelsPeople = await fetchAllLevels().catch(() => []);
  card.levels = findLevelsEntries(levelsPeople, targetUser.first, targetUser.last);
  const accessToken = await getGoogleAccessToken();
  const range = `'${APP_SHEET_TAB}'!A:K`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await r.json();
  const rows = (data.values || []).slice(1);
  const row = rows.find(row =>
    (row[0] || "").trim().toLowerCase() === targetUser.first.trim().toLowerCase() &&
    (row[1] || "").trim().toLowerCase() === targetUser.last.trim().toLowerCase()
  );
  if (!row) return card;
  const [, , email, , ip, location, mbtiCode, sheetPersona16p, praPersona, , sheetGender] = row;

  let geo = targetUser.locationOverride || (ip ? await geolocateIpCached(ip) : null);
  if (!geo && location) geo = await geocodeLocationTextCached(location);
  if (geo) card.location = { city: geo.city, region: geo.region, country: geo.country };

  const archetypeMaps = buildArchetypeImageMaps();
  const gender = targetUser.gender || (sheetGender || "").toLowerCase() || "male";
  card.gender = gender;
  const pick = entry => entry ? (entry[gender] || entry.male || null) : null;
  const matchedArchetype =
    archetypeMaps.byTitle[(praPersona || "").toLowerCase()] ||
    archetypeMaps.byCode[(mbtiCode || "").toUpperCase()] ||
    archetypeMaps.byStandard[(sheetPersona16p || "").toLowerCase()] ||
    null;
  card.archetypeImage = pick(matchedArchetype) || getLatestArchetypeImage(email) || null;
  card.archetypeTitle = matchedArchetype?.title || null;
  return card;
}

// Attaches role/profilePictureFileId/location/archetype to each Levels-sheet
// entry, same App-sheet matching as fetchUserProfileCard() above but done
// once as a batch instead of once per person — the Levels page (staff-only)
// wants to show the same profile header the map popup does, right on each
// card. Matched by name only (like findLevelsEntries already does), not by
// chat account id — same convention this whole file already uses to bridge
// the Levels sheet, the App sheet, and chat accounts, none of which share a
// key any other way.
async function enrichLevelsPeople(people) {
  const localUsers = readJson(USERS_FILE, []);
  const accessToken = await getGoogleAccessToken();
  const range = `'${APP_SHEET_TAB}'!A:K`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await r.json();
  const rows = (data.values || []).slice(1);
  const archetypeMaps = buildArchetypeImageMaps();

  return Promise.all(people.map(async p => {
    const localUser = localUsers.find(u =>
      u.first.trim().toLowerCase() === p.first.trim().toLowerCase() &&
      u.last.trim().toLowerCase() === p.last.trim().toLowerCase()
    );
    const row = rows.find(row =>
      (row[0] || "").trim().toLowerCase() === p.first.trim().toLowerCase() &&
      (row[1] || "").trim().toLowerCase() === p.last.trim().toLowerCase()
    );
    const enriched = {
      ...p,
      role: localUser?.role || null,
      profilePictureFileId: localUser?.profilePictureFileId || null,
      location: null, archetypeImage: null, archetypeTitle: null,
    };
    if (!row) return enriched;
    const [, , email, , ip, location, mbtiCode, sheetPersona16p, praPersona, , sheetGender] = row;
    let geo = localUser?.locationOverride || (ip ? await geolocateIpCached(ip) : null);
    if (!geo && location) geo = await geocodeLocationTextCached(location);
    if (geo) enriched.location = { city: geo.city, region: geo.region, country: geo.country };
    const gender = localUser?.gender || (sheetGender || "").toLowerCase() || "male";
    const pick = entry => entry ? (entry[gender] || entry.male || null) : null;
    const matchedArchetype =
      archetypeMaps.byTitle[(praPersona || "").toLowerCase()] ||
      archetypeMaps.byCode[(mbtiCode || "").toUpperCase()] ||
      archetypeMaps.byStandard[(sheetPersona16p || "").toLowerCase()] ||
      null;
    enriched.archetypeImage = pick(matchedArchetype) || getLatestArchetypeImage(email) || null;
    enriched.archetypeTitle = matchedArchetype?.title || null;
    return enriched;
  }));
}

let levelsCache = null; // { at, people } — 10-minute cache, same idea as the geo caches below
async function fetchLevelsTab(tabName, program) {
  const accessToken = await getGoogleAccessToken();
  const range = `'${tabName}'!A1:J`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${LEVELS_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const d = await r.json();
  const rows = d.values || [];
  const header = rows[0] || [];
  const firstIdx = header.indexOf("FIRST NAME");
  const lastIdx = header.indexOf("LAST NAME");
  const teamIdx = header.indexOf("Team");
  const catIdx = LEVELS_CATEGORIES.map(c => header.indexOf(c));
  const people = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const first = row[firstIdx];
    if (!first) continue;
    const levels = {};
    LEVELS_CATEGORIES.forEach((cat, ci) => {
      const v = catIdx[ci] >= 0 ? row[catIdx[ci]] : undefined;
      if (v) levels[cat] = v;
    });
    const team = teamIdx >= 0 ? !!String(row[teamIdx] || "").trim() : false;
    people.push({ first, last: row[lastIdx] || "", program, levels, team });
  }
  return people;
}
async function fetchAllLevels() {
  if (levelsCache && Date.now() - levelsCache.at < 10 * 60 * 1000) return levelsCache.people;
  const [gym, online] = await Promise.all([
    fetchLevelsTab("GYM", "Gym"),
    fetchLevelsTab("ONLINE", "Online"),
  ]);
  const people = [...gym, ...online];
  levelsCache = { at: Date.now(), people };
  return people;
}
function findLevelsEntries(people, first, last) {
  const f = String(first || "").trim().toLowerCase();
  const l = String(last || "").trim().toLowerCase();
  if (!f || !l) return [];
  return people.filter(p => p.first.trim().toLowerCase() === f && p.last.trim().toLowerCase() === l);
}

// ── Online/Gym eligibility ───────────────────────────────────────────────
// A plain "user" account is promoted to "online" or "gym" once their name
// shows up in the matching sales sheet (they've actually signed up for that
// program) — as long as they aren't on the shared blacklist, checked two
// ways: the dedicated BLACKLIST tab, and a "BLACKLIST" marker some rows
// carry directly in their own Status column instead.
const ONLINE_SHEET_TAB = "ONLINE KICKOFF / BUYERS";
const GYM_SHEET_TAB = "GYM KICKOFF / BUYERS";
const STUDENT_BLACKLIST_TAB = "BLACKLIST ONLINE & GYM";
function nameKey(first, last) {
  return `${String(first || "").trim().toLowerCase()}|${String(last || "").trim().toLowerCase()}`;
}
let studentEligibilityCache = null; // { at, online: Set<nameKey>, gym: Set<nameKey> } — 10-minute cache, same idea as the levels cache
async function fetchStudentEligibility() {
  if (studentEligibilityCache && Date.now() - studentEligibilityCache.at < 10 * 60 * 1000) return studentEligibilityCache;
  const accessToken = await getGoogleAccessToken();
  async function fetchTab(tabName, range) {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${tabName}'!${range}`)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const d = await r.json();
    return (d.values || []).slice(1); // drop header row
  }
  const [blacklistRows, onlineRows, gymRows] = await Promise.all([
    fetchTab(STUDENT_BLACKLIST_TAB, "A1:B"),
    fetchTab(ONLINE_SHEET_TAB, "A1:E"),
    fetchTab(GYM_SHEET_TAB, "A1:E"),
  ]);
  const blacklisted = new Set(blacklistRows.filter(([first, last]) => first || last).map(([first, last]) => nameKey(first, last)));
  function toEligibleSet(rows) {
    const eligible = new Set();
    rows.forEach(([first, last, , , status]) => {
      if (!first && !last) return;
      const key = nameKey(first, last);
      if (blacklisted.has(key)) return;
      if (String(status || "").toUpperCase().includes("BLACKLIST")) return;
      eligible.add(key);
    });
    return eligible;
  }
  studentEligibilityCache = { at: Date.now(), online: toEligibleSet(onlineRows), gym: toEligibleSet(gymRows) };
  return studentEligibilityCache;
}
// Auto-promotes any plain "user" whose name is now sheet-eligible to
// "online" or "gym" (gym takes priority if somehow eligible for both) — a
// manual admin override to any other role always takes precedence going
// forward, since this only ever touches accounts still sitting at the plain
// "user" default.
async function syncStudentRoles(users) {
  try {
    const { online, gym } = await fetchStudentEligibility();
    let changed = false;
    users.forEach(u => {
      if (u.role !== "user") return;
      const key = nameKey(u.first, u.last);
      if (gym.has(key)) { u.role = "gym"; changed = true; }
      else if (online.has(key)) { u.role = "online"; changed = true; }
    });
    if (changed) { writeJson(USERS_FILE, users); syncDefaultGroups(); }
  } catch (e) {
    console.error("[student role sync]", e.message); // best-effort — never blocks the admin panel from loading
  }
}

// ── Retreats page content ───────────────────────────────────────────────
// Pulls the live pacificrimathletics.com/retreats page server-side and
// strips it down to just the actual retreat content — the site's own nav,
// footer, promo banner, and "Apply for Training" buttons are cut, since
// this renders inside our own app chrome (which already has its own nav
// and its own Apply for Training button elsewhere). Framer (the site's
// builder) renders full content into the initial HTML for SEO, so a plain
// fetch + static DOM parse is enough — no headless browser/JS execution.
// Rough centroid per location name, just enough to place a marker on the
// Strength Ninjas map — not meant to be precise.
const RETREAT_LOCATION_COORDS = {
  thailand: { lat: 13.7563, lng: 100.5018 },
  california: { lat: 36.7783, lng: -119.4179 },
  florida: { lat: 27.9944, lng: -81.7603 },
  alaska: { lat: 64.2008, lng: -149.4937 },
  spain: { lat: 40.4637, lng: -3.7492 },
  france: { lat: 46.6034, lng: 1.8883 },
  portugal: { lat: 39.3999, lng: -8.2245 },
  japan: { lat: 36.2048, lng: 138.2529 },
  georgia: { lat: 32.1656, lng: -82.9001 },
  atlanta: { lat: 33.749, lng: -84.388 },
  "north carolina": { lat: 35.7596, lng: -79.0193 },
};

// Removes the topmost element(s) containing `snippet`, capped at `maxLen`
// characters of text — without the cap, the match would climb all the way
// up to some page-spanning wrapper (everything "contains" the snippet
// somewhere inside it) and delete the whole page instead of just the one
// small banner/button that actually holds that text.
function removeElementsContaining(root, snippet, maxLen) {
  const matches = [...root.querySelectorAll("*")].filter(el =>
    el.textContent.includes(snippet) && el.textContent.trim().length <= maxLen
  );
  const topmost = matches.filter(el => !matches.some(other => other !== el && other.contains(el)));
  topmost.forEach(el => el.remove());
}

async function fetchRetreatsPage() {
  const r = await fetch("https://www.pacificrimathletics.com/retreats", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PRAApp/1.0)" },
  });
  if (!r.ok) throw new Error("Retreats page fetch failed: " + r.status);
  const html = await r.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const main = doc.getElementById("main") || doc.body;

  main.querySelectorAll("nav, footer, script, style").forEach(el => el.remove());
  removeElementsContaining(main, "Apply NOW", 300);
  [...main.querySelectorAll("a, button")].forEach(el => {
    if (el.textContent.trim().toUpperCase().includes("APPLY FOR TRAINING")) el.remove();
  });

  // "Upcoming Retreats" — every LOCATION-then-4-digit-year heading that
  // appears before the page's own "PAST EVENTS" divider, deduplicated
  // (Framer renders each one 2-3x, once per responsive breakpoint).
  const allEls = [...main.querySelectorAll("*")];
  const elIndex = new Map(allEls.map((el, i) => [el, i]));
  const pastMarker = allEls.find(el => el.children.length === 0 && el.textContent.trim() === "PAST EVENTS");
  const upcomingRetreats = [];
  if (pastMarker) {
    const seen = new Set();
    const headingEls = allEls.filter(el => el.children.length === 0 && /^[A-Za-z][A-Za-z ]+ \d{4}$/.test(el.textContent.trim()));
    const pastMarkerIdx = elIndex.get(pastMarker);
    headingEls.forEach(el => {
      const startIdx = elIndex.get(el);
      const isBeforePast = startIdx < pastMarkerIdx;
      const text = el.textContent.trim();
      if (!isBeforePast || seen.has(text)) return;
      seen.add(text);
      const m = text.match(/^(.+?)\s+(\d{4})$/);
      if (!m) return;
      const location = m[1].trim();
      const year = m[2];
      const coords = RETREAT_LOCATION_COORDS[location.toLowerCase()];

      // Each retreat's own heading, photo, and description all sit together
      // in document order (the page repeats this whole block once per
      // retreat), bounded by wherever the NEXT different retreat's heading
      // starts — that's a much more reliable per-retreat boundary than
      // trying to climb the DOM tree, since Framer's slider markup nests
      // every retreat's assets under the same few shared ancestor wrappers.
      let endIdx = pastMarkerIdx;
      headingEls.forEach(other => {
        const oi = elIndex.get(other);
        if (oi > startIdx && oi < endIdx && other.textContent.trim() !== text) endIdx = oi;
      });

      let photo = null;
      const descParts = [];
      const descSeen = new Set();
      for (let i = startIdx; i < endIdx; i++) {
        const node = allEls[i];
        if (!photo && node.tagName === "IMG" && node.getAttribute("src")) {
          try { photo = new URL(node.getAttribute("src"), "https://www.pacificrimathletics.com/retreats").href; }
          catch { photo = node.getAttribute("src"); }
        }
        if (node.tagName === "P") {
          const t = node.textContent.trim();
          if (t.length > 8 && !descSeen.has(t)) { descSeen.add(t); descParts.push(t); }
        }
      }
      const description = descParts.slice(0, 6);

      upcomingRetreats.push({ location, year, lat: coords?.lat ?? null, lng: coords?.lng ?? null, photo, description });
    });
  }

  // Any link still left in the content (e.g. a stray internal "home" link)
  // points at the site's own relative path — rewrite to absolute + open in
  // a new tab, since it's now embedded inside a different app entirely.
  [...main.querySelectorAll("a[href]")].forEach(a => {
    const href = a.getAttribute("href");
    if (href && !/^https?:\/\//i.test(href) && !href.startsWith("#")) {
      try { a.setAttribute("href", new URL(href, "https://www.pacificrimathletics.com/retreats").href); } catch {}
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
  });

  return { html: main.innerHTML, upcomingRetreats };
}

// Finds the person's row in the given program's tab by name and overwrites
// it (or appends a new row if they're not on the sheet yet) with the given
// levels/team values. Column positions are read from the header each time
// rather than hardcoded, so reordering columns in the sheet doesn't break this.
async function updateLevelsRow({ first, last, program, levels, team }) {
  const tabName = program === "Online" ? "ONLINE" : "GYM";
  const accessToken = await getGoogleAccessToken();
  const range = `'${tabName}'!A1:J`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${LEVELS_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  const rows = getData.values || [];
  const header = rows[0] || [];
  const firstIdx = header.indexOf("FIRST NAME");
  const lastIdx = header.indexOf("LAST NAME");
  const teamIdx = header.indexOf("Team");
  const catIdx = LEVELS_CATEGORIES.map(c => header.indexOf(c));
  const width = header.length;

  const newRow = new Array(width).fill("");
  newRow[firstIdx] = first;
  newRow[lastIdx] = last;
  LEVELS_CATEGORIES.forEach((cat, ci) => { if (catIdx[ci] >= 0) newRow[catIdx[ci]] = levels[cat] || ""; });
  if (teamIdx >= 0) newRow[teamIdx] = team ? "X" : "";

  const f = first.trim().toLowerCase(), l = last.trim().toLowerCase();
  const rowIndex = rows.findIndex((r, i) =>
    i > 0 && String(r[firstIdx] || "").trim().toLowerCase() === f && String(r[lastIdx] || "").trim().toLowerCase() === l
  );
  const colLetter = (idx) => String.fromCharCode(65 + idx);
  if (rowIndex > 0) {
    const sheetRow = rowIndex + 1;
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${LEVELS_SHEET_ID}/values/${encodeURIComponent(`'${tabName}'!A${sheetRow}:${colLetter(width - 1)}${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [newRow] }) }
    );
  } else {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${LEVELS_SHEET_ID}/values/${encodeURIComponent(`'${tabName}'!A1:${colLetter(width - 1)}1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [newRow] }) }
    );
  }
  levelsCache = null; // next read should reflect the write immediately
}

// Generic Gmail send, factored out of what used to be the password-reset-only
// sender — appointment confirmations reuse the exact same MIME/base64url path.
// `attachments` (optional) switches to a multipart/mixed body — used for the
// .ics calendar file so Apple Calendar / Outlook desktop users get a
// double-click "add to calendar" without needing a Google-specific link.
async function sendEmail(toEmail, toName, subject, html, attachments = []) {
  const accessToken = await getGoogleAccessToken();
  const headerLines = [
    `From: "PRA Chat" <lee@pacificrimathletics.com>`,
    `To: ${toName ? `"${toName}" <${toEmail}>` : toEmail}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    `MIME-Version: 1.0`,
  ];
  let mimeLines;
  if (attachments.length) {
    const boundary = "prabnd" + randomUUID().replace(/-/g, "");
    const parts = [`--${boundary}`, `Content-Type: text/html; charset=UTF-8`, ``, html];
    for (const att of attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        ``,
        Buffer.from(att.content).toString("base64"),
      );
    }
    parts.push(`--${boundary}--`);
    mimeLines = [...headerLines, `Content-Type: multipart/mixed; boundary="${boundary}"`, ``, ...parts].join("\r\n");
  } else {
    mimeLines = [...headerLines, `Content-Type: text/html; charset=UTF-8`, ``, html].join("\r\n");
  }
  const base64url = Buffer.from(mimeLines).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64url }),
  });
  if (!r.ok) throw new Error("Gmail send failed: " + (await r.text()));
}

// ── "Add to Calendar" links + universal .ics file for appointment emails ──
function icsDate(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function icsEscape(s) { return String(s || "").replace(/[\\,;]/g, m => "\\" + m).replace(/\n/g, "\\n"); }

function buildGoogleCalendarLink({ summary, description, start, end, timezone }) {
  const params = new URLSearchParams({
    action: "TEMPLATE", text: summary, details: description || "",
    dates: `${icsDate(start)}/${icsDate(end)}`, ctz: timezone,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
function buildOutlookCalendarLink({ summary, description, start, end }) {
  const params = new URLSearchParams({
    path: "/calendar/action/compose", rru: "addevent",
    subject: summary, body: description || "", startdt: start.toISOString(), enddt: end.toISOString(),
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
// Plain .ics (no METHOD:REQUEST) — a downloadable event file, not a formal
// invite. The formal invite with accept/decline already comes separately
// from Google Calendar itself (sendUpdates=all on the event); this is just
// the universal "add this to whatever calendar app you use" fallback for
// Apple Calendar / Outlook desktop, which don't follow web links the way
// Google/Outlook.com do.
function buildIcs({ summary, description, start, end, uid }) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pacific Rim Athletics//PRA Chat//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}@pacificrimathletics.com`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}
function addToCalendarButtonsHtml({ summary, description, start, end, timezone, uid }) {
  const gLink = buildGoogleCalendarLink({ summary, description, start, end, timezone });
  const oLink = buildOutlookCalendarLink({ summary, description, start, end });
  const btn = (href, label) => `<a href="${href}" style="display:inline-block;margin:4px 6px 4px 0;padding:8px 14px;background:#009bff;color:#fff;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:13px">${label}</a>`;
  return `<div style="margin-top:16px">
    ${btn(gLink, "Add to Google Calendar")}
    ${btn(oLink, "Add to Outlook.com")}
    <span style="display:inline-block;margin:4px 0;font-family:sans-serif;font-size:12px;color:#888">Using Apple Calendar or desktop Outlook? Open the attached .ics file.</span>
  </div>`;
}

async function sendPasswordResetEmail(toEmail, toName, resetUrl) {
  const html = `
    <p>Hi ${toName || "there"},</p>
    <p>Someone requested a password reset for your PRA Chat account. If this was you, click below to set a new password — this link expires in 1 hour.</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `;
  await sendEmail(toEmail, toName, "Reset your PRA Chat password", html);
}

// ── Google Calendar — one connected account (lee@pacificrimathletics.com,
// via the one-time get_calendar_token.js script) is enough for every coach,
// not just Lee. Confirmed directly: within a Google Workspace domain,
// calendars are visible/writable to a domain member without any per-person
// OAuth or service-account setup — verified by creating and immediately
// deleting a real test event on a coach's calendar using only this one
// token. So instead of impersonating each coach, we just target their
// calendar by ID (their email) while staying authenticated as this one
// connected account.
async function getCalendarAccessToken() {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN_PRA_CALENDAR;
  if (!refreshToken) throw new Error("Google Calendar not connected — run get_calendar_token.js once, see Admin > Appointments.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Calendar token refresh failed: " + JSON.stringify(d));
  return d.access_token;
}

// Creates the event directly on the coach's own calendar (calendarId = their
// real email) and adds each client as an attendee (one for a 1:1 session,
// several for a group session) — Google sends each of them its own invite
// email (with an "Add to Calendar" action) which lands on their calendar
// too once accepted.
async function createCalendarEvent({ summary, description, startISO, durationMinutes, attendees, timezone, calendarId }) {
  const accessToken = await getCalendarAccessToken();
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const body = {
    summary, description,
    start: { dateTime: start.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
    attendees: (attendees || []).map(a => ({ email: a.email, displayName: a.name })),
    reminders: { useDefault: true },
  };
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || "primary")}/events?sendUpdates=all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Calendar event creation failed: " + JSON.stringify(d));
  return { id: d.id, htmlLink: d.htmlLink };
}

// sendUpdates=all makes Google email every attendee a cancellation notice
// itself — same mechanism createCalendarEvent relies on for the original
// invite, so cancelling gets that same built-in notification for free.
async function deleteCalendarEvent({ eventId, calendarId }) {
  const accessToken = await getCalendarAccessToken();
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || "primary")}/events/${eventId}?sendUpdates=all`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 410 Gone means it's already deleted/cancelled — treat as success, not an error.
  if (!r.ok && r.status !== 404 && r.status !== 410) {
    const d = await r.json().catch(() => ({}));
    throw new Error("Calendar event deletion failed: " + JSON.stringify(d));
  }
}

// ── SMS via Close CRM (same account already used for the YT law SMS
// sequences). Close's one-off /activity/sms/ send needs a lead_id, so we
// look the client up by email first — if they're not a Close lead (e.g. a
// gym-only account never routed through the sales pipeline) this throws and
// the caller treats it as a soft failure rather than blocking the schedule.
async function sendApptSms(toEmail, toPhone, text) {
  const CLOSE_API_KEY = process.env.CLOSE_API_KEY;
  const CLOSE_FROM_PHONE = process.env.CLOSE_FROM_PHONE;
  if (!CLOSE_API_KEY || !CLOSE_FROM_PHONE) throw new Error("CLOSE_API_KEY / CLOSE_FROM_PHONE not set in .env");
  if (!toPhone) throw new Error("Client has no phone number on file");
  const auth = "Basic " + Buffer.from(CLOSE_API_KEY + ":").toString("base64");
  const leadRes = await fetch(`https://api.close.com/api/v1/lead/?query=${encodeURIComponent("email:" + toEmail)}`, { headers: { Authorization: auth } });
  const leadData = await leadRes.json();
  const lead = (leadData.data || [])[0];
  if (!lead) throw new Error("No matching Close lead found for " + toEmail);
  const r = await fetch("https://api.close.com/api/v1/activity/sms/", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ lead_id: lead.id, local_phone: CLOSE_FROM_PHONE, remote_phone: toPhone, direction: "outbound", status: "outbox", text }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Close SMS send failed: " + JSON.stringify(d));
  return d;
}

// Cheap {{token}} substitution — templates are plain strings edited in the
// admin panel, not a templating engine, so this stays intentionally simple.
function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
}

// Converts a wall-clock date+time in a specific IANA zone to the correct
// absolute UTC Date — used for the Gym schedule's fixed slots, which are
// always meant literally as "4:15pm Anchorage time" regardless of which
// timezone the device doing the booking happens to be in. Standard trick:
// treat the wall-clock string as if it were UTC, then measure how far that
// same instant actually reads in the target zone vs. true UTC, and shift by
// the difference. Naturally DST-correct for the given date since both sides
// are evaluated for that specific date, not a fixed offset.
function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const asIfUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const tzString = asIfUtc.toLocaleString("en-US", { timeZone });
  const utcString = asIfUtc.toLocaleString("en-US", { timeZone: "UTC" });
  const offset = new Date(tzString).getTime() - new Date(utcString).getTime();
  return new Date(asIfUtc.getTime() - offset);
}
// Weekday (0=Sun..6=Sat) of a date as observed in a specific IANA zone —
// needed for the Gym schedule's Mon-Fri check, since a UTC calendar date can
// be a different weekday than the same instant read in Anchorage.
function weekdayInZone(dateStr, timeZone) {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon UTC — safely mid-day in any real-world zone, avoids date-boundary edge cases
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
}

// ── Appointment reminders ───────────────────────────────────────────────
// Polls booked appointments (chat_appointments.json) and fires email/SMS
// reminders at the admin-configured lead times before each session. Each
// (appointment, channel, reminder-index) triple is recorded in
// appt.remindersSent once sent, so re-polling never double-sends — the
// poll interval only controls how much delay a reminder can have past its
// exact target minute, not correctness.
async function checkAppointmentReminders() {
  const cfg = getConfig();
  const apptCfg = cfg.appointments;
  const appointments = readJson("chat_appointments.json", []);
  if (!appointments.length) return;
  const users = readJson(USERS_FILE, []);
  const now = Date.now();
  let changed = false;

  for (const appt of appointments) {
    const startMs = new Date(appt.startISO).getTime();
    if (!startMs || startMs <= now) continue; // session already happened — nothing left to remind about
    // clientIds is the current shape (DM or group); clientId is the older
    // single-recipient shape from before group scheduling existed.
    const clientIds = appt.clientIds || (appt.clientId ? [appt.clientId] : []);
    const clients = clientIds.map(id => users.find(u => u.id === id)).filter(Boolean);
    const coach = users.find(u => u.id === appt.coachId);
    if (!clients.length || !coach) continue;
    appt.remindersSent = appt.remindersSent || [];

    const start = new Date(appt.startISO);
    const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: apptCfg.timezone });
    const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: apptCfg.timezone });
    const coachName = `${coach.first} ${coach.last}`;

    // Email/SMS are addressed per recipient, and tracked per recipient too
    // (key includes their id) — a group reminder that partly fails
    // shouldn't re-send to whoever already got theirs on the next poll.
    const emailSmsJobs = [
      ...(apptCfg.emailRemindersEnabled ? (apptCfg.emailReminderMinutesBefore || []).map((minutesBefore, index) => ({ channel: "email", index, minutesBefore })) : []),
      ...(apptCfg.smsRemindersEnabled ? (apptCfg.smsReminderMinutesBefore || []).map((minutesBefore, index) => ({ channel: "sms", index, minutesBefore })) : []),
    ];
    for (const job of emailSmsJobs) {
      if (now < startMs - job.minutesBefore * 60000) continue; // not due yet
      for (const client of clients) {
        const key = `${job.channel}:${job.index}:${client.id}`;
        if (appt.remindersSent.includes(key)) continue;
        // Each recipient's own stored timezone, not the shared admin
        // default — same reasoning as the initial booking confirmation.
        const clientTz = client.timezone || apptCfg.timezone;
        const clientDateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: clientTz });
        const clientTimeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: clientTz });
        const vars = { coachName, firstName: client.first, lastName: client.last, date: clientDateStr, time: clientTimeStr, duration: appt.durationMinutes };
        try {
          if (job.channel === "email") {
            const subjectTpl = apptCfg.emailReminderUsesInitialTemplate ? apptCfg.emailSubjectTemplate : apptCfg.emailReminderSubjectTemplate;
            const bodyTpl = apptCfg.emailReminderUsesInitialTemplate ? apptCfg.emailBodyTemplate : apptCfg.emailReminderBodyTemplate;
            await sendEmail(client.email, `${client.first} ${client.last}`, fillTemplate(subjectTpl, vars), fillTemplate(bodyTpl, vars));
          } else {
            const smsTpl = apptCfg.smsReminderUsesInitialTemplate ? apptCfg.smsTemplate : apptCfg.smsReminderTemplate;
            await sendApptSms(client.email, client.phone, fillTemplate(smsTpl, vars));
          }
          appt.remindersSent.push(key);
          changed = true;
        } catch (e) {
          // Not marked as sent — retried on the next poll. If persistently
          // failing (bad phone number, etc.) it just keeps retrying
          // harmlessly until the session time passes and it's skipped above.
          console.error(`[appointment reminder] ${job.channel} #${job.index} for appt ${appt.id} (${client.id}) failed:`, e.message);
        }
      }
    }

    // Messenger is one shared post to the conversation (plus a push to
    // every participant), not per recipient — same as the original
    // scheduling confirmation.
    if (apptCfg.messengerRemindersEnabled) {
      for (const [index, minutesBefore] of (apptCfg.messengerReminderMinutesBefore || []).entries()) {
        const key = `messenger:${index}`;
        if (appt.remindersSent.includes(key)) continue;
        if (now < startMs - minutesBefore * 60000) continue;
        try {
          const vars = { coachName, firstName: clients.map(c => `${c.first} ${c.last}`).join(", "), lastName: "", date: dateStr, time: timeStr, duration: appt.durationMinutes };
          // "Use default" re-posts the same rich appointment bubble (with
          // its Calendar/Zoom links) the original booking confirmation
          // used, by looking up that link off the original message
          // (appt.id === the original message's id).
          const messages = readJson(MESSAGES_FILE, []);
          const reminderMsg = apptCfg.messengerReminderUseDefault
            ? { id: randomUUID(), conversationId: appt.conversationId, senderId: appt.coachId, type: "appointment",
                startISO: appt.startISO, durationMinutes: appt.durationMinutes, timezone: appt.isGym ? "America/Anchorage" : null,
                isGym: !!appt.isGym, clientIds: appt.clientIds || [],
                googleEventId: appt.googleEventId, googleEventLink: messages.find(m => m.id === appt.id)?.googleEventLink || null,
                createdAt: new Date().toISOString() }
            : { id: randomUUID(), conversationId: appt.conversationId, senderId: appt.coachId, type: "text",
                text: fillTemplate(apptCfg.messengerReminderTemplate, vars), createdAt: new Date().toISOString() };
          messages.push(reminderMsg);
          writeJson(MESSAGES_FILE, messages);
          const pushBody = apptCfg.messengerReminderUseDefault ? `📅 Reminder: session ${dateStr} at ${timeStr}` : fillTemplate(apptCfg.messengerReminderTemplate, vars);
          await notifyParticipants(appt.conversationId, appt.coachId, { title: coachName, body: pushBody, conversationId: appt.conversationId }).catch(() => {});
          appt.remindersSent.push(key);
          changed = true;
        } catch (e) {
          console.error(`[appointment reminder] messenger #${index} for appt ${appt.id} failed:`, e.message);
        }
      }
    }
  }
  if (changed) writeJson("chat_appointments.json", appointments);
}

setInterval(() => {
  checkAppointmentReminders().catch(e => console.error("[appointment reminders]", e.message));
}, 60 * 1000);

// ── Physique weekly check-in reminders ───────────────────────────────────
// Same polling pattern as checkAppointmentReminders above: a plain
// setInterval reading the relevant data file, with a per-user "already
// reminded" timestamp (physiqueCheckinReminderSentAt) so crossing the
// 7-day threshold doesn't re-notify on every poll tick.
const CHECKIN_REMINDER_DAYS = 7;
async function checkPhysiqueCheckinReminders() {
  const users = readJson(USERS_FILE, []);
  const stats = readJson("chat_body_stats.json", {});
  const now = Date.now();
  let changed = false;
  for (const user of users) {
    if (user.archived) continue;
    // Opt-out, not opt-in -- default on for everyone unless an admin has
    // explicitly turned it off for this user.
    if (user.physiqueCheckinNotifsEnabled === false) continue;

    const checkins = (stats[user.id] || []).filter(e => e.source === "checkin");
    const lastCheckinAt = checkins.length
      ? checkins.reduce((latest, e) => (new Date(e.createdAt) > new Date(latest) ? e.createdAt : latest), checkins[0].createdAt)
      : null;
    const daysSinceCheckin = lastCheckinAt ? (now - new Date(lastCheckinAt).getTime()) / 86400000 : Infinity;
    if (daysSinceCheckin < CHECKIN_REMINDER_DAYS) continue;

    const daysSinceReminder = user.physiqueCheckinReminderSentAt
      ? (now - new Date(user.physiqueCheckinReminderSentAt).getTime()) / 86400000 : Infinity;
    if (daysSinceReminder < CHECKIN_REMINDER_DAYS) continue;

    const targets = readJson(PUSH_FILE, []).filter(s => s.userId === user.id);
    if (targets.length) {
      await sendPushToTargets(targets, {
        title: "Weekly check-in",
        body: "It's time for your weekly physique check-in — snap a photo and log your weight.",
      }).catch(() => {});
    }
    user.physiqueCheckinReminderSentAt = new Date().toISOString();
    changed = true;
  }
  if (changed) writeJson(USERS_FILE, users);
}
setInterval(() => {
  checkPhysiqueCheckinReminders().catch(e => console.error("[physique checkin reminders]", e.message));
}, 60 * 60 * 1000); // hourly polling is plenty of resolution for a 7-day threshold

// ── Auto-labeling uploads: "FIRST LAST BEST-GUESS-OF-CONTENT" ──────────────
// Chat and body/move-scan uploads land in Drive named after who sent them
// and a short AI guess at what's actually in the shot (e.g. "LEE WEILAND
// HANDSTAND HOLD") instead of a bare sequence number — makes the raw Drive
// folders actually browsable/searchable later, matching how the existing
// training-footage library is already named by the coaches themselves.
// ffmpeg-static's default export is the correct binary PATH FOR WHATEVER
// PLATFORM npm install actually ran on — this used to be a hardcoded
// `../node_modules/ffmpeg-static/ffmpeg.exe` (a Windows-only path one
// directory above chat-app itself), which only ever resolved locally.
// Railway deploys just the chat-app folder — no ".." sibling exists there,
// and the binary installed by `npm install` on Railway's Linux build
// wouldn't have a .exe suffix anyway — so every ffmpeg call in production
// was silently failing and falling back to whatever each caller does on
// error (extractVideoFrame: a generic label; trimVideo: skip the trim and
// keep the full-length clip).
const FFMPEG_EXE = ffmpegPath;

async function guessContentLabel(imageBuffer, mimeType) {
  try {
    const base64 = imageBuffer.toString("base64");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You label fitness-training photos for a file name. Reply with 2-5 words describing the specific movement, body part, or subject shown — nothing else. No punctuation, no explanation, no quotes. Examples: HANDSTAND HOLD, PULL UP ATTEMPT, GROUP PHOTO, ANKLE INJURY, MUSCLE UP, TRAINING SETUP. If genuinely unclear, reply TRAINING PHOTO." },
          { role: "user", content: [
            { type: "text", text: "Label this photo per the system instructions." },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          ] },
        ],
        max_tokens: 20,
        temperature: 0.2,
      }),
    });
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content || "";
    // Strip anything that isn't a normal word/space/number — a stray period
    // or quote from the model becomes part of the Drive filename otherwise.
    const cleaned = text.replace(/[^a-zA-Z0-9 ]/g, "").trim();
    return cleaned || "TRAINING PHOTO";
  } catch (e) {
    console.error("[guessContentLabel]", e.message);
    return "TRAINING PHOTO";
  }
}

// In-app camera capture (training-protocol's mobile record flow) trims
// client-side by picking start/end seconds on a timeline, but the actual
// cut happens here, server-side, with the rest of this file's other ffmpeg
// work — `-ss` before `-i` is a fast input seek, `-t` (not `-to`) gives an
// unambiguous output duration relative to that seek point regardless of
// where `-ss` sits, avoiding -to's absolute-vs-relative ambiguity.
function trimVideo(inputPath, outputPath, startSec, endSec) {
  execFileSync(FFMPEG_EXE, [
    "-y", "-ss", String(Math.max(0, startSec)), "-i", inputPath,
    "-t", String(Math.max(0.1, endSec - startSec)),
    "-c:v", "libx264", "-c:a", "aac", "-preset", "veryfast", "-avoid_negative_ts", "make_zero",
    outputPath,
  ], { stdio: ["pipe", "pipe", "pipe"], timeout: 60000 });
}

// One frame, one second in (skips a possible black/blank opening frame),
// small enough to send straight to the vision model without extra resizing.
function extractVideoFrame(videoPath) {
  const framePath = videoPath + "-frame.jpg";
  try {
    execFileSync(FFMPEG_EXE, ["-y", "-ss", "1", "-i", videoPath, "-frames:v", "1", "-vf", "scale=512:-1", framePath],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
    const buffer = readFileSync(framePath);
    return buffer;
  } catch (e) {
    console.error("[extractVideoFrame]", e.message);
    return null;
  } finally {
    try { unlinkSync(framePath); } catch {}
  }
}

// Stream a single multipart file part directly into a Drive resumable upload
// (no full-buffer in memory — important for large, intentionally-uncompressed video).
export function uploadStreamToDrive(fileStream, { name, mimeType, folderId, accessToken }) {
  return new Promise((resolve, reject) => {
    const metadata = { name };
    if (folderId) metadata.parents = [folderId];
    const initBody = JSON.stringify(metadata);

    const initReq = httpsRequest({
      hostname: "www.googleapis.com",
      path: "/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,webViewLink",
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(initBody),
        "X-Upload-Content-Type": mimeType,
      },
    }, initRes => {
      let d = ""; initRes.on("data", c => d += c);
      initRes.on("end", () => {
        const location = initRes.headers.location;
        if (!location || initRes.statusCode >= 300) {
          reject(new Error(`Drive resumable init failed: ${initRes.statusCode} ${d}`)); return;
        }
        const loc = new URL(location);
        const putReq = httpsRequest({
          hostname: loc.hostname,
          path: loc.pathname + loc.search,
          method: "PUT",
          headers: { "Content-Type": mimeType },
        }, putRes => {
          let pd = ""; putRes.on("data", c => pd += c);
          putRes.on("end", () => {
            if (putRes.statusCode >= 300) { reject(new Error(`Drive upload failed: ${putRes.statusCode} ${pd}`)); return; }
            try { resolve(JSON.parse(pd)); } catch (e) { reject(e); }
          });
        });
        putReq.on("error", reject);
        fileStream.pipe(putReq);
      });
    });
    initReq.on("error", reject);
    initReq.write(initBody);
    initReq.end();
  });
}

// Creates a new native Google Doc (fileId omitted) or overwrites an
// existing one's content (fileId given) by uploading plain text with
// mimeType left as "application/vnd.google-apps.document" in the file
// metadata — Drive auto-converts the plain-text body into a real Doc on
// import, same as pasting text into a blank Doc. Deliberately NOT reusing
// uploadStreamToDrive above: that helper uploads the media as-is (fine for
// images/video, where metadata.mimeType and the upload Content-Type are
// the same value) — a Doc import needs metadata.mimeType to be the target
// Workspace type while the actual upload Content-Type stays "text/plain",
// which is a different enough shape to not force into that function.
function createOrUpdateDriveDoc({ fileId, name, folderId, content, accessToken }) {
  return new Promise((resolve, reject) => {
    const isUpdate = !!fileId;
    const metadata = isUpdate ? {} : { name, mimeType: "application/vnd.google-apps.document", parents: folderId ? [folderId] : undefined };
    const initBody = JSON.stringify(metadata);
    const initPath = isUpdate
      ? `/upload/drive/v3/files/${fileId}?uploadType=resumable&fields=id,name,webViewLink`
      : `/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink`;

    const initReq = httpsRequest({
      hostname: "www.googleapis.com",
      path: initPath,
      method: isUpdate ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(initBody),
        "X-Upload-Content-Type": "text/plain",
      },
    }, initRes => {
      let d = ""; initRes.on("data", c => d += c);
      initRes.on("end", () => {
        const location = initRes.headers.location;
        if (!location || initRes.statusCode >= 300) { reject(new Error(`Drive doc init failed: ${initRes.statusCode} ${d}`)); return; }
        const loc = new URL(location);
        const body = Buffer.from(content, "utf8");
        const putReq = httpsRequest({
          hostname: loc.hostname,
          path: loc.pathname + loc.search,
          method: "PUT",
          headers: { "Content-Type": "text/plain; charset=UTF-8", "Content-Length": body.length },
        }, putRes => {
          let pd = ""; putRes.on("data", c => pd += c);
          putRes.on("end", () => {
            if (putRes.statusCode >= 300) { reject(new Error(`Drive doc upload failed: ${putRes.statusCode} ${pd}`)); return; }
            try { resolve(JSON.parse(pd)); } catch (e) { reject(e); }
          });
        });
        putReq.on("error", reject);
        putReq.end(body);
      });
    });
    initReq.on("error", reject);
    initReq.write(initBody);
    initReq.end();
  });
}

// Mirrors chat.html's INTAKE_FIELDS — kept in sync by hand (same pattern
// as the icon SVGs duplicated across this app's pages). Only used to give
// the exported Doc real section headers/labels instead of raw JSON keys.
const INTAKE_FIELD_LABELS = [
  ["Program Info", [["program", "Program"], ["timezone", "Timezone"], ["emailPhone", "Email / Phone Number"], ["goals", "Goals"]]],
  ["Basics", [["date", "Kickoff Date"], ["age", "Age"], ["height", "Height"], ["weight", "Weight"], ["mindset", "Mindset"], ["frequencyWants", "Frequency Wants/Needs"], ["timePerSession", "Time per Session"]]],
  ["Scales", [["movementScale", "Movement Scale"], ["flexibilityScale", "Flexibility Scale"], ["commVsComprehension", "Communication vs Comprehension"], ["sedentariness", "Sedentariness (Standing/Sitting)"], ["painDescriptors", "Pain Descriptors (if any)"]]],
  ["Background", [["intakeInfo", "Intake Info (injury history, past events)"], ["whyPacRim", "Why Pac Rim (goals & limitations)"], ["sportsBackground", "Sports / Background / Hobbies / Profession"], ["tenMoveQuizNotes", "10-Move Quiz Notes"], ["additionalNotes", "Additional Notes"], ["homework", "Homework Before We Meet Again"]]],
  ["Nutrition", [["allergiesRestrictions", "Allergies & Restrictions"], ["staplesDairy", "Staple Foods — Dairy (examples)"], ["staplesProtein", "Staple Foods — Protein (examples)"], ["staplesVeggies", "Staple Foods — Veggies (examples)"], ["staplesFruitsNuts", "Staple Foods — Fruits & Nuts (examples)"], ["staplesGrains", "Staple Foods — Grains & Breads (examples)"], ["staplesMisc", "Misc"]]],
];
function formatIntakeDoc(fields, clientName, submitterName, submittedAt) {
  let out = `${clientName} — Kickoff / Intake Form\nSubmitted by ${submitterName} on ${new Date(submittedAt).toLocaleString()}\n\n`;
  INTAKE_FIELD_LABELS.forEach(([section, keys]) => {
    out += `${section.toUpperCase()}\n`;
    keys.forEach(([key, label]) => { out += `${label}: ${fields[key] || ""}\n`; });
    out += "\n";
  });
  return out;
}

// Mirrors chat.html's NOTE_FIELDS — same "ZOOM session" table shape as the
// source doc (Zoom Date, 1:1 Type, Sent Vids, Mindset, Coach, ...).
const NOTE_FIELD_LABELS = [
  ["zoomDate", "Zoom Date"], ["oneOnOneType", "1:1 Type"], ["sentVids", "Sent Vids"],
  ["mindset", "Mindset"], ["coach", "Coach"], ["painDescriptors", "Pain Descriptors (if injury assessment)"],
  ["trainingFrequency", "Training Frequency for Prior Week"],
  ["progressionsRemove", "Progressions Made/Exercises Changed — Remove"],
  ["progressionsAdd", "Progressions Made/Exercises Changed — Add"],
  ["injuriesPainConcerns", "Injuries / Pain / Concerns Notes"],
  ["movesDoneLive", "Moves Done Live"], ["additionalNotes", "Additional Notes"],
];
function formatNoteEntry(fields, authorName, createdAt) {
  const heading = fields.zoomDate ? `ZOOM — ${fields.zoomDate}` : `ZOOM — ${new Date(createdAt).toLocaleDateString()}`;
  let out = `${heading}\nLogged by ${authorName} on ${new Date(createdAt).toLocaleString()}\n\n`;
  NOTE_FIELD_LABELS.forEach(([key, label]) => { out += `${label}: ${fields[key] || ""}\n`; });
  out += `\n${"─".repeat(40)}\n\n`;
  return out;
}

// Plain-text export of an existing Doc's current content — used to read a
// client's notes doc before prepending a fresh entry to the top of it.
async function exportDriveDocText(fileId, accessToken) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Drive doc export failed: ${r.status}`);
  return await r.text();
}

// Copies a chat media file into the configured favorites folder under a
// coach-chosen name, then (best-effort) transfers ownership of that COPY to
// the coach's own Google account. The app has exactly one Drive connection
// (GOOGLE_REFRESH_TOKEN_PRA) — this is the only way an individual coach ends
// up actually owning a file, short of every coach separately connecting
// their own Google account. Everyone here is @pacificrimathletics.com (same
// Workspace domain as the connected account), so the transfer completes
// silently; if a domain policy ever blocks that, this still succeeds — the
// coach just falls back to a plain "writer" share instead of ownership, so
// they're never locked out of a copy they just made.
async function copyFileToFavorites({ sourceFileId, name, folderId, ownerEmail, accessToken }) {
  const copyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${sourceFileId}/copy?fields=id,name,webViewLink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [folderId], description: `Favorited by ${ownerEmail} via PRA chat` }),
  });
  const copy = await copyRes.json();
  if (!copy.id) throw new Error("Drive copy failed: " + JSON.stringify(copy));

  async function share(role) {
    return fetch(`https://www.googleapis.com/drive/v3/files/${copy.id}/permissions?sendNotificationEmail=false${role === "owner" ? "&transferOwnership=true" : ""}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role, type: "user", emailAddress: ownerEmail }),
    }).then(r => r.json());
  }
  let ownershipTransferred = false;
  try {
    const perm = await share("owner");
    ownershipTransferred = !perm.error;
  } catch { /* falls through to the writer-share fallback below */ }
  if (!ownershipTransferred) {
    try { await share("writer"); } catch { /* copy still exists under the shared account either way */ }
  }

  return { id: copy.id, name: copy.name, webViewLink: copy.webViewLink, ownershipTransferred };
}

// Drive's `'<id>' in parents` query only matches DIRECT children — it does
// not recurse into subfolders. The training-protocol video picker needs to
// search everything under the configured root folder, including however
// many levels of subfolders a coach has organized videos into, so we walk
// the folder tree ourselves (breadth-first, one Drive query per level) and
// return every folder id found. Cached briefly since this can be a handful
// of round-trips and the picker re-queries on every keystroke (debounced).
const folderTreeCache = new Map(); // rootId -> { ids, expiresAt }
async function getAllDescendantFolderIds(rootId, accessToken) {
  const cached = folderTreeCache.get(rootId);
  if (cached && cached.expiresAt > Date.now()) return cached.ids;

  const all = [rootId];
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length && depth < 8) { // sane recursion cap, not a real limit on realistic folder trees
    const orClauses = frontier.map(id => `'${id}' in parents`).join(" or ");
    const q = `(${orClauses}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1000`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const d = await r.json();
    const ids = (d.files || []).map(f => f.id);
    if (!ids.length) break;
    all.push(...ids);
    frontier = ids;
    depth++;
  }
  folderTreeCache.set(rootId, { ids: all, expiresAt: Date.now() + 5 * 60 * 1000 });
  return all;
}

// ── Push notifications ──────────────────────────────────────────────────
// Two kinds of target share PUSH_FILE: `subscription` (browser Web Push,
// see /push-subscribe) and `nativeToken` (FCM/APNs via Capacitor's
// PushNotifications plugin, see /push-subscribe-native) — a target only
// ever has one or the other, dispatched accordingly below.

// Lazy + cached: `undefined` means "haven't tried yet", `null` means "tried
// and there's no service account configured" (native push silently no-ops
// rather than erroring every send) — a real app is only ever built once
// credentials exist.
let firebaseApp;
let firebaseInitError = null; // surfaced by /api/chat/push-debug so this doesn't need Railway log access to diagnose
function getFirebaseApp() {
  if (firebaseApp !== undefined) return firebaseApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) { firebaseApp = null; return null; }
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    firebaseApp = admin.initializeApp({ credential: admin.cert(serviceAccount) });
  } catch (e) {
    console.error("[firebase] init failed:", e.message);
    firebaseInitError = e.message;
    firebaseApp = null;
  }
  return firebaseApp;
}

// userId -> {conversationId, updatedAt} for whatever conversation is
// currently open on that user's screen. In-memory only — reported live by
// the client via /api/chat/active-conversation, so it resets harmlessly on
// a redeploy. Entries expire after ACTIVE_CONVO_TTL_MS rather than only
// clearing on an explicit "closed"/"backgrounded" report — iOS doesn't
// reliably fire the visibilitychange event a backgrounding app depends on
// to send that report (confirmed: a real backgrounding left this stuck
// pointing at a conversation someone was no longer looking at, which
// silently ate a push that should have gone through). The client also
// re-reports on an interval while a conversation stays open, so a real,
// still-open conversation never actually goes stale mid-suppression.
const ACTIVE_CONVO_TTL_MS = 20000;
const activeConversations = new Map();
function isViewingConversation(userId, conversationId) {
  const entry = activeConversations.get(userId);
  return !!entry && entry.conversationId === conversationId && (Date.now() - entry.updatedAt) < ACTIVE_CONVO_TTL_MS;
}

// conversationId -> Map<userId, updatedAt> of who's currently typing there.
// Same self-expiring shape as activeConversations, for the same reason: the
// client just pings this on keystrokes rather than needing a reliable
// "stopped typing" event (blur, send, backgrounding — any of which could
// get missed), and a stale flag can't outlive TYPING_TTL_MS regardless.
const TYPING_TTL_MS = 4000;
const typingUsers = new Map();
function getTypingUserIds(conversationId, excludeUserId) {
  const entries = typingUsers.get(conversationId);
  if (!entries) return [];
  const now = Date.now();
  const ids = [];
  for (const [userId, updatedAt] of entries) {
    if (userId === excludeUserId) continue;
    if (now - updatedAt < TYPING_TTL_MS) ids.push(userId);
  }
  return ids;
}

async function notifyParticipants(conversationId, excludeUserId, payload) {
  const convos = readJson(CONVOS_FILE, []);
  const convo = convos.find(c => c.id === conversationId);
  if (!convo) return;
  const subs = readJson(PUSH_FILE, []);
  const targets = subs.filter(s => convo.participantIds.includes(s.userId) && s.userId !== excludeUserId && !isViewingConversation(s.userId, conversationId));
  await sendPushToTargets(targets, payload);
}

// Guideline 1.2 (UGC safety) requires reports/blocks to notify "the
// developer" — admins are the closest equivalent this app has to that, so a
// report fires the exact same push path a new message would, just aimed at
// every admin/admin2 instead of a conversation's participants.
async function notifyAdmins(payload) {
  const users = readJson(USERS_FILE, []);
  const adminIds = new Set(users.filter(isAdmin).map(u => u.id));
  const subs = readJson(PUSH_FILE, []);
  const targets = subs.filter(s => adminIds.has(s.userId));
  await sendPushToTargets(targets, payload);
}

async function sendPushToTargets(targets, payload) {
  ensureVapidKeys();
  const fbApp = getFirebaseApp();
  // This whole path used to fail completely silently — no log for a
  // misconfigured/missing Firebase credential, none for a send that threw
  // for a reason other than the two "token is dead, drop it" cases below.
  // A native push just not arriving looked identical whether the token
  // never got sent, Firebase rejected it, or it genuinely delivered — this
  // makes each of those distinguishable from Railway's logs.
  if (targets.some(t => t.nativeToken?.platform === "android") && !fbApp) {
    console.error("[push] native Android target(s) present but Firebase isn't configured — check FIREBASE_SERVICE_ACCOUNT_JSON");
  }
  if (targets.some(t => t.nativeToken?.platform === "ios") && !apnsConfigured()) {
    console.error("[push] native iOS target(s) present but APNs isn't configured — check APNS_KEY_ID / APNS_TEAM_ID / APNS_AUTH_KEY_B64");
  }
  for (const target of targets) {
    try {
      if (target.subscription) {
        await webPush.sendNotification(target.subscription, JSON.stringify(payload));
      } else if (target.nativeToken?.platform === "ios") {
        // @capacitor/push-notifications hands iOS the raw APNs device
        // token, not an FCM registration token — this app has no Firebase
        // iOS SDK to do that exchange, so it has to go straight to Apple's
        // APNs API rather than through getMessaging().send(). See apns.js.
        await sendApnsPush(target.nativeToken.token, {
          title: payload.title, body: payload.body, conversationId: payload.conversationId,
        });
      } else if (target.nativeToken && fbApp) {
        await getMessaging(fbApp).send({
          token: target.nativeToken.token,
          notification: { title: payload.title, body: payload.body },
          data: { conversationId: String(payload.conversationId || "") },
          // FCM defaults to "normal" priority with no explicit sound —
          // Android can silently defer/suppress a normal-priority message
          // for a backgrounded app (Doze mode, battery optimization), and
          // no sound field means it may not audibly alert even when shown.
          // Both are well-documented "server accepted it, device never
          // surfaced it" causes. Not setting a custom channelId here — an
          // Android channel ID that doesn't actually exist on the device
          // silently drops the notification entirely, which is worse than
          // omitting it and letting the plugin's own default channel apply.
          android: { priority: "high", notification: { sound: "default", visibility: "public", icon: "ic_stat_notify", color: "#009BFF" } },
        });
      }
    } catch (e) {
      // Subscription/token likely expired/revoked — drop it silently.
      if (target.subscription && (e.statusCode === 404 || e.statusCode === 410)) {
        const remaining = readJson(PUSH_FILE, []).filter(s => s.subscription?.endpoint !== target.subscription.endpoint);
        writeJson(PUSH_FILE, remaining);
      } else if (target.nativeToken?.platform === "ios" && (e.status === 400 || e.status === 410)) {
        const remaining = readJson(PUSH_FILE, []).filter(s => s.nativeToken?.token !== target.nativeToken.token);
        writeJson(PUSH_FILE, remaining);
      } else if (target.nativeToken && e.code === "messaging/registration-token-not-registered") {
        const remaining = readJson(PUSH_FILE, []).filter(s => s.nativeToken?.token !== target.nativeToken.token);
        writeJson(PUSH_FILE, remaining);
      } else {
        console.error("[push] send failed for user", target.userId, target.nativeToken ? `(native/${target.nativeToken.platform})` : "(web)", e.code || e.status || e.statusCode || e.message);
      }
    }
  }
}

// ── Access rules ─────────────────────────────────────────────────────────
// admin2 has every admin capability except the Admin Panel page itself
// (that page's own access gate stays hardcoded to "admin" — see
// admin-panel.html's init()). Every other admin-only check in this file
// goes through isAdmin() so admin2 gets full parity everywhere else.
export function isAdmin(user) { return user.role === "admin" || user.role === "admin2"; }
export function isStaff(user) { return user.role === "coach" || isAdmin(user); }
// "online" and "gym" are both client-facing training roles -- same
// permissions/behaviors everywhere, just tracking which program someone's
// actually enrolled in.
function isClientRole(role) { return role === "online" || role === "gym"; }

// Every plain "user" and every online/gym client gets their OWN dedicated
// group (not one shared group for everyone), named "First Last Group" --
// a user's has them + every admin/admin2, an online/gym client's has them +
// every admin/admin2/coach. Re-run after anything that could change who
// belongs in a group (signup, role change, archive/unarchive, the
// auto-promotion sync, a new admin/coach joining) so every existing
// person's group picks up staff roster changes too, not just brand new
// accounts. Matched by autoGroupUserId, not name, so a duplicate name never
// collides with the wrong person's group. A group stays put (frozen, not
// deleted) once someone's archived or promoted out of user/online/gym --
// preserves history instead of losing it.
function syncDefaultGroups() {
  const users = readJson(USERS_FILE, []);
  const convos = readJson(CONVOS_FILE, []);
  const active = users.filter(u => !u.archived);
  const adminIds = active.filter(u => isAdmin(u)).map(u => u.id);
  const coachIds = active.filter(u => u.role === "coach").map(u => u.id);

  // Normalizes to Title Case regardless of how the name is actually stored
  // (someone typed "JOHN SMITH" in all caps, etc.) so the generated group
  // name always reads as a normal name, never shouty.
  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/(^|[\s'-])\S/g, (c) => c.toUpperCase());
  }
  function ensurePersonalGroup(person, autoType, staffIds) {
    const desired = Array.from(new Set([person.id, ...staffIds]));
    const name = `${titleCase(person.first)} ${titleCase(person.last)} Group`;
    let convo = convos.find(c => c.autoGroupType === autoType && c.autoGroupUserId === person.id);
    if (!convo) {
      convos.push({ id: randomUUID(), type: "group", name, participantIds: desired, autoGroupType: autoType, autoGroupUserId: person.id, createdBy: null, createdAt: new Date().toISOString() });
    } else {
      convo.name = name;
      if (JSON.stringify([...convo.participantIds].sort()) !== JSON.stringify([...desired].sort())) {
        convo.participantIds = desired;
      }
    }
  }
  active.forEach(u => {
    // Plain "user" accounts (a free/unpaid signup) get no group at all —
    // only actually becoming an online/gym client creates one, including
    // every admin/admin2/coach.
    if (isClientRole(u.role)) ensurePersonalGroup(u, "student", [...adminIds, ...coachIds]);
  });
  writeJson(CONVOS_FILE, convos);
}

// Team-chat-first policy: a plain user/online/gym account can never
// initiate a DM at all (no directory to pick anyone from in the first
// place — see the /contacts endpoint below — but this is the real
// enforcement). Coaches lose 1:1 access to clients too, on purpose, so
// coaching happens visibly in the shared group instead of private DMs —
// only an admin/admin2 can start a new DM reaching a user/online/gym
// account. Staff-to-staff DMs (any mix of coach/admin/admin2) are
// unaffected either direction.

function canCreateDm(creator, otherUser) {
  const creatorIsClient = !isStaff(creator);
  const otherIsClient = !isStaff(otherUser);
  if (creatorIsClient) return isAdmin(otherUser);
  if (otherIsClient) return isAdmin(creator);
  return true;
}

// Run once at boot too, so the two groups reflect the current roster right
// away (covers the accounts renamed student->online moments ago, and any
// roster drift from before this feature existed) without waiting for the
// next signup/role-change to trigger it.
syncDefaultGroups();

// ── Read receipts (WhatsApp-style: sent / delivered / read) ────────────────
// "Delivered" is set the moment a recipient's own client actually fetches
// this message (see the GET /messages handler below, which stamps every
// non-mine message it returns) — not just when it lands in MESSAGES_FILE,
// since this is a poll-based app with no push-to-device signal of its own.
// "Read" reuses the readState timestamp conversations already track for
// unread-badge counting: a message is read by someone once their own
// last-read-at for this conversation is at or after the message's
// createdAt. A group only shows "read" once EVERY other participant has
// read it (matches the common simplified-group convention rather than
// per-person granularity, which the UI has no way to surface here anyway).
// deliveredTo defaults to [] via `m.deliveredTo || []` rather than being
// set at creation time in each of the several message-creation call
// sites — one read-side default is simpler than keeping all of them in
// sync, and functionally identical (nothing reads it before the first
// GET stamps it anyway).
function computeMessageStatus(m, convo, users) {
  const recipients = convo.participantIds.filter(id => id !== m.senderId);
  if (!recipients.length) return "sent";
  const delivered = recipients.every(id => (m.deliveredTo || []).includes(id));
  if (!delivered) return "sent";
  const read = recipients.every(id => {
    const u = users.find(x => x.id === id);
    const lastReadAt = u?.readState?.[convo.id];
    return lastReadAt && new Date(lastReadAt) >= new Date(m.createdAt);
  });
  return read ? "read" : "delivered";
}

// ── Video calls ──────────────────────────────────────────────────────────
// One in-flight call per conversation at a time — /call/start is idempotent
// against this (returns the existing one instead of creating a second),
// and it's what a rejoin/refresh keys off of too.
function findOpenCall(conversationId) {
  const calls = readJson(CALLS_FILE, []);
  return calls.find(c => c.conversationId === conversationId && (c.status === "ringing" || c.status === "active")) || null;
}
// Trimmed to what the client actually needs — never the Daily room name
// (only the URL, which is what daily-js actually joins with).
function publicCall(c) {
  if (!c) return null;
  const { dailyRoomName, ...rest } = c;
  return rest;
}

// A WhatsApp-style "call" bubble in the thread, written once a call is
// truly over (not on every ringing/decline-in-a-group step — see the
// callers below). "completed" vs "missed" is the only distinction that
// matters to a viewer -- whether call.startedAt ever got set, i.e. whether
// a second person actually joined -- chat.html's renderCallBubble derives
// the "Missed video call" vs "No answer" wording from whichever side of it
// the viewer was on.
function createCallMessage(call) {
  const outcome = call.startedAt ? "completed" : "missed";
  const durationSeconds = call.startedAt ? Math.max(0, Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)) : null;
  const msg = {
    id: randomUUID(), conversationId: call.conversationId, senderId: call.initiatorId,
    type: "call", callId: call.id, callOutcome: outcome, durationSeconds,
    createdAt: call.endedAt,
  };
  const messages = readJson(MESSAGES_FILE, []);
  messages.push(msg);
  writeJson(MESSAGES_FILE, messages);
  notifyParticipants(call.conversationId, null, {
    title: "Video call", body: outcome === "missed" ? "Missed video call" : "Video call ended", conversationId: call.conversationId,
  }).catch(() => {});
}

// Fire-and-forget from the call's /end handler -- Daily finalizes a
// recording a few seconds after everyone leaves, not instantly, so this
// polls rather than blocking the HTTP response on it. Only ever called for
// a call that actually reached "active" (startedAt set); a call nobody
// answered has nothing to record.
async function archiveCallRecording(call) {
  try {
    let recording = null;
    for (let i = 0; i < 24; i++) {
      const list = await listDailyRecordings(call.dailyRoomName);
      recording = list.find(r => r.status === "finished");
      if (recording) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!recording) { console.error("[call recording] never finished for room", call.dailyRoomName); return; }

    const cfg = getConfig();
    if (!cfg.callRecordingsFolderId) { console.error("[call recording] no callRecordingsFolderId configured -- set it in the admin panel"); return; }

    const downloadLink = await getDailyRecordingAccessLink(recording.id);
    const driveDownloadRes = await fetch(downloadLink);
    if (!driveDownloadRes.ok || !driveDownloadRes.body) throw new Error("Could not fetch the finished recording from Daily");

    const users = readJson(USERS_FILE, []);
    const participants = call.participantIds.map(id => users.find(u => u.id === id)).filter(Boolean);
    const student = participants.find(u => isClientRole(u.role));
    const coach = participants.find(u => isStaff(u));
    const namePart = [student, coach].filter(Boolean).map(u => `${u.first} ${u.last}`).join(" ") || "Video Call";
    const dateStr = new Date(call.startedAt).toISOString().slice(0, 10);

    const accessToken = await getDriveAccessToken();
    await uploadStreamToDrive(Readable.fromWeb(driveDownloadRes.body), {
      name: `${namePart} ${dateStr}.mp4`, mimeType: "video/mp4", folderId: cfg.callRecordingsFolderId, accessToken,
    });

    // Now archived in Drive -- no reason to also keep paying Daily's own
    // storage rate for the same footage indefinitely.
    await deleteDailyRecording(recording.id).catch(() => {});
  } catch (e) {
    console.error("[call recording] archive failed for call", call.id, e.message);
  }
}

// ── Route handler ────────────────────────────────────────────────────────
export async function handleChatRequest(req, res, url) {
  const p = url.pathname;

  // ─── Auth ───────────────────────────────────────────────────────────────
  if (req.method === "POST" && p === "/api/auth/signup") {
    const ct = req.headers["content-type"] || "";
    let fields = {}, profilePictureFileId = null;
    // Generated up front (not down at user-record-creation time) so the
    // profile-photo upload counter and the final user record share the same
    // id — otherwise a photo added at signup and one added later via the
    // profile page would number from two disconnected counters and could
    // collide on the same filename.
    const newUserId = randomUUID();

    if (ct.startsWith("multipart/form-data")) {
      const parsed = await new Promise((resolve, reject) => {
        const bb = Busboy({ headers: req.headers });
        const f = {}; let uploadPromise = null;
        bb.on("field", (name, val) => { f[name] = val; });
        bb.on("file", (name, stream, info) => {
          if (name !== "profilePicture") { stream.resume(); return; }
          uploadPromise = (async () => {
            try {
              const accessToken = await getDriveAccessToken();
              const cfg = getConfig();
              const n = nextUploadNumber(newUserId, "profilePhoto");
              const ext = extFromMime(info.mimeType, info.filename);
              const result = await uploadStreamToDrive(stream, {
                name: `${f.first || "Unknown"} ${f.last || "User"} PROFILE PHOTO ${n}${ext}`,
                mimeType: info.mimeType, folderId: cfg.profilePhotosFolderId, accessToken,
              });
              return result.id;
            } catch { return null; }
          })();
        });
        bb.on("finish", async () => { resolve({ f, profilePictureFileId: uploadPromise ? await uploadPromise : null }); });
        bb.on("error", reject);
        req.pipe(bb);
      });
      fields = parsed.f;
      profilePictureFileId = parsed.profilePictureFileId;
    } else {
      fields = await readJsonBody(req);
    }

    const { first, last, email, phone, password, agreedToTerms } = fields;
    if (!first || !last || !email || !password) return sendJson(res, 400, { error: "first, last, email, password are required" });
    // Guideline 1.2 requires agreement to no-tolerance terms BEFORE an
    // account is created — enforced server-side too since the checkbox
    // itself is just client-side HTML that a direct API call would skip.
    if (agreedToTerms !== "true" && agreedToTerms !== true) {
      return sendJson(res, 400, { error: "You must agree to the Terms of Use to create an account" });
    }

    const users = readJson(USERS_FILE, []);
    if (users.some(u => u.email.toLowerCase() === String(email).toLowerCase())) {
      return sendJson(res, 409, { error: "An account with that email already exists" });
    }
    const { salt, hash } = hashPassword(password);
    const ip = getClientIp(req);
    const geo = await geolocateIp(ip); // best-effort — null on failure/local IP, never blocks signup
    const user = {
      id: newUserId,
      first, last, email: String(email).toLowerCase(), phone: phone || "",
      passwordSalt: salt, passwordHash: hash,
      role: users.length === 0 ? "admin" : "user", // first-ever signup bootstraps the admin
      profilePictureFileId: profilePictureFileId || null,
      ip, geo, // geo: { city, region, country, lat, lng } | null — used by the users map
      createdAt: new Date().toISOString(),
      // Only reachable once the agreedToTerms check above passed, so this
      // is always "now" -- a durable record of *when* they agreed, not
      // just that the gate was satisfied at signup (which itself wasn't
      // being persisted anywhere before this).
      termsAcceptedAt: new Date().toISOString(),
    };
    users.push(user);
    writeJson(USERS_FILE, users);
    syncDefaultGroups();
    const token = createSession(user.id);
    setSessionCookie(res, token);
    const locationStr = geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(", ") : "";
    upsertAppSheetRow({ first, last, email: user.email, phone, ip, location: locationStr }).catch(e => console.error("[APP sheet sync]", e.message));
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }

  if (req.method === "POST" && p === "/api/auth/forgot-password") {
    const { email } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.email.toLowerCase() === String(email || "").toLowerCase());
    // Always return the same generic response whether or not the email exists,
    // so this endpoint can't be used to enumerate registered accounts.
    if (user) {
      const resets = readJson(RESETS_FILE, {});
      const token = randomBytes(32).toString("hex");
      resets[token] = { userId: user.id, expiresAt: Date.now() + 60 * 60 * 1000 };
      writeJson(RESETS_FILE, resets);
      const host = req.headers.host || "localhost:3456";
      const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
      const resetUrl = `${protocol}://${host}/chat-app/reset-password.html?token=${token}`;
      sendPasswordResetEmail(user.email, `${user.first} ${user.last}`, resetUrl)
        .catch(e => console.error("[password reset email]", e.message));
    }
    return sendJson(res, 200, { ok: true, message: "If that email has an account, a reset link is on its way." });
  }

  if (req.method === "POST" && p === "/api/auth/reset-password") {
    const { token, newPassword } = await readJsonBody(req);
    if (!token || !newPassword || newPassword.length < 8) {
      return sendJson(res, 400, { error: "A valid token and a password of at least 8 characters are required" });
    }
    const resets = readJson(RESETS_FILE, {});
    const entry = resets[token];
    if (!entry || entry.expiresAt < Date.now()) {
      return sendJson(res, 400, { error: "This reset link is invalid or has expired" });
    }
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.id === entry.userId);
    if (!user) return sendJson(res, 400, { error: "Account no longer exists" });
    const { salt, hash } = hashPassword(newPassword);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    writeJson(USERS_FILE, users);
    delete resets[token];
    writeJson(RESETS_FILE, resets);
    upsertAppSheetRow({ first: user.first, last: user.last, email: user.email, phone: user.phone })
      .catch(e => console.error("[APP sheet sync]", e.message));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/auth/login") {
    const { email, password } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const user = users.find(u => u.email.toLowerCase() === String(email || "").toLowerCase());
    if (!user || !verifyPassword(password || "", user.passwordSalt, user.passwordHash)) {
      return sendJson(res, 401, { error: "Invalid email or password" });
    }
    if (user.archived) return sendJson(res, 403, { error: "This account has been archived." });
    const token = createSession(user.id);
    setSessionCookie(res, token);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }

  // Change password while logged in (distinct from the token-based
  // forgot-password email flow above) — requires the current password.
  if (req.method === "POST" && p === "/api/auth/change-password") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const { currentPassword, newPassword } = await readJsonBody(req);
    if (!newPassword || newPassword.length < 8) {
      return sendJson(res, 400, { error: "New password must be at least 8 characters" });
    }
    if (!verifyPassword(currentPassword || "", me.passwordSalt, me.passwordHash)) {
      return sendJson(res, 401, { error: "Current password is incorrect" });
    }
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === me.id);
    const { salt, hash } = hashPassword(newPassword);
    target.passwordSalt = salt;
    target.passwordHash = hash;
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/auth/logout") {
    const token = getCookie(req, "pra_session");
    if (token) destroySession(token);
    res.setHeader("Set-Cookie", "pra_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && p === "/api/auth/me") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (req.method === "POST" && p === "/api/auth/update-profile") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const ct = req.headers["content-type"] || "";
    let fields = {}, newProfilePictureFileId = undefined;
    if (ct.startsWith("multipart/form-data")) {
      const parsed = await new Promise((resolve, reject) => {
        const bb = Busboy({ headers: req.headers });
        const f = {}; let uploadPromise = null;
        bb.on("field", (name, val) => { f[name] = val; });
        bb.on("file", (name, stream, info) => {
          if (name !== "profilePicture") { stream.resume(); return; }
          uploadPromise = (async () => {
            try {
              const accessToken = await getDriveAccessToken();
              const cfg = getConfig();
              const n = nextUploadNumber(me.id, "profilePhoto");
              const ext = extFromMime(info.mimeType, info.filename);
              const result = await uploadStreamToDrive(stream, {
                name: `${f.first || me.first} ${f.last || me.last} PROFILE PHOTO ${n}${ext}`,
                mimeType: info.mimeType, folderId: cfg.profilePhotosFolderId, accessToken,
              });
              return result.id;
            } catch { return null; }
          })();
        });
        bb.on("finish", async () => resolve({ f, id: uploadPromise ? await uploadPromise : undefined }));
        bb.on("error", reject);
        req.pipe(bb);
      });
      fields = parsed.f;
      newProfilePictureFileId = parsed.id;
    } else {
      fields = await readJsonBody(req);
    }
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === me.id);
    if (fields.first) target.first = fields.first;
    if (fields.last) target.last = fields.last;
    if (fields.phone !== undefined) target.phone = fields.phone;
    if (fields.zoomLink !== undefined) target.zoomLink = fields.zoomLink;
    if (newProfilePictureFileId) target.profilePictureFileId = newProfilePictureFileId;
    // A self-reported location overrides the sheet's IP/text-based geocoding
    // everywhere it's read (map dot, profile card) — lets someone fix a
    // wrong auto-detected city, or set one at all if their sheet row has
    // neither an IP nor a location string. Clearing the field (empty
    // string) drops back to the automatic sheet-derived location instead
    // of leaving a stale override in place.
    let locationError;
    if (fields.location !== undefined) {
      const text = fields.location.trim();
      if (!text) {
        delete target.locationOverride;
      } else {
        const geo = await geocodeLocationTextCached(text);
        if (geo) target.locationOverride = { text, ...geo };
        else locationError = "Couldn't find that location — try a city and state/country.";
      }
    }
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(target), locationError });
  }

  // Self-reported IANA timezone (e.g. "America/Denver"), detected client-side
  // from the browser's own Intl settings on every page load and posted here
  // whenever it differs from what's stored — keeps it current automatically
  // as someone travels, no settings screen needed. Powers per-recipient
  // appointment display (chat header/bubble, email, SMS) so each person sees
  // times in their own zone instead of one fixed zone for everyone.
  if (p === "/api/chat/me/timezone" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const { timezone } = await readJsonBody(req);
    if (!timezone || typeof timezone !== "string" || timezone.length > 100) return sendJson(res, 400, { error: "Invalid timezone" });
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === me.id);
    if (target && target.timezone !== timezone) {
      target.timezone = timezone;
      writeJson(USERS_FILE, users);
    }
    return sendJson(res, 200, { ok: true });
  }

  const userLookupMatch = p.match(/^\/api\/chat\/users\/([^/]+)$/);
  if (userLookupMatch && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === userLookupMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    return sendJson(res, 200, { user: publicUser(target) });
  }

  // Quick actions from the chat Levels modal — coaches (not just admins) can
  // move a client between user/online/gym or archive/unarchive them right
  // from the chat, without needing Admin Panel access. Deliberately narrower
  // than the admin panel's own role/archive endpoints: only allows moving
  // between user/online/gym (never promoting to coach/admin/admin2) and only
  // targets someone who's currently one of those three, so a coach can never
  // touch a staff account through this path.
  const quickRoleMatch = p.match(/^\/api\/chat\/users\/([^/]+)\/role$/);
  if (quickRoleMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isStaff(me)) return sendJson(res, 403, { error: "Coaches and admins only" });
    const { role } = await readJsonBody(req);
    if (!["user", "online", "gym"].includes(role)) return sendJson(res, 400, { error: "role must be 'user', 'online', or 'gym'" });
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === quickRoleMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    if (!["user", "online", "gym"].includes(target.role)) return sendJson(res, 400, { error: "Can only switch between user/online/gym this way" });
    target.role = role;
    writeJson(USERS_FILE, users);
    syncDefaultGroups();
    syncAppSheetRole(target).catch(e => console.error("[APP sheet role sync]", e.message));
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }

  const quickArchiveMatch = p.match(/^\/api\/chat\/users\/([^/]+)\/archived$/);
  if (quickArchiveMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isStaff(me)) return sendJson(res, 403, { error: "Coaches and admins only" });
    const { archived } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === quickArchiveMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    if (!["user", "online", "gym"].includes(target.role)) return sendJson(res, 400, { error: "Can only archive a user/online/gym account this way" });
    target.archived = !!archived;
    writeJson(USERS_FILE, users);
    syncDefaultGroups();
    if (target.archived) {
      const sessions = readJson(SESSIONS_FILE, {});
      Object.keys(sessions).forEach(token => { if (sessions[token].userId === target.id) delete sessions[token]; });
      writeJson(SESSIONS_FILE, sessions);
    }
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }

  // ─── Media streaming proxy (Range-aware) ─────────────────────────────────
  // Handled before the generic /api/chat/ prefix guard below, since that
  // guard's own catch-all 404 would otherwise swallow this route first.
  const mediaMatch = p.match(/^\/api\/chat\/media\/([^/]+)$/);
  if (mediaMatch && req.method === "GET") {
    const mediaUser = getSessionUser(req);
    if (!mediaUser) { res.writeHead(401); res.end(); return true; }
    const fileId = mediaMatch[1];
    // Only allow access if this file is attached to a message in a conversation
    // the requester participates in, or is someone's profile picture.
    const messages = readJson(MESSAGES_FILE, []);
    const msg = messages.find(m => m.driveFileId === fileId);
    const allUsers = readJson(USERS_FILE, []);
    const isProfilePic = allUsers.some(u => u.profilePictureFileId === fileId);
    if (!isProfilePic) {
      if (msg) {
        const convos = readJson(CONVOS_FILE, []);
        const convo = convos.find(c => c.id === msg.conversationId);
        if (!convo || !convo.participantIds.includes(mediaUser.id)) { res.writeHead(403); res.end(); return true; }
      } else {
        // Not a chat-message attachment — check whether it's a training-protocol
        // step's video/image (these are never posted as chat messages, so the
        // check above always missed them and every step video/image 404'd).
        const allProtocols = readJson(TRAINING_PROTOCOLS_FILE, {});
        const ownerId = Object.keys(allProtocols).find(uid => (allProtocols[uid].steps || []).some(s => s.driveFileId === fileId));
        if (ownerId) {
          if (mediaUser.id !== ownerId && !isStaff(mediaUser)) { res.writeHead(403); res.end(); return true; }
        } else if (isStaff(mediaUser)) {
          // Not attached to any step yet — this is the "Choose a Video" search
          // picker generating a thumbnail preview before a step is saved.
          // search-videos is already staff-only, so staff previewing any file
          // it surfaced is consistent with access already granted there.
        } else {
          res.writeHead(404); res.end(); return true;
        }
      }
    }
    try {
      const accessToken = await getDriveAccessToken();
      await streamDriveMedia(req, res, fileId, accessToken);
    } catch (e) {
      res.writeHead(500); res.end("Media fetch failed: " + e.message);
    }
    return true;
  }

  // ─── Personality Quiz lead submission ──────────────────────────────────
  // The quiz frontend (chat-app/personality-quiz/index.html) computes a
  // result client-side and posts it here. This route previously existed
  // ONLY in the separate root server.js used for local dev — never in this
  // file, which is what Railway actually runs — so every real submission
  // 404'd silently (the frontend never checks the response and redirects
  // to the results page regardless of outcome). updatePersonalityColumn
  // (above) was already correct; it just had nothing calling it in prod.
  const PERSONALITY_LEADS_FILE = "personality-quiz/leads.json";
  const PERSONALITY_QUIZ_SHEET_ID = "1SQPcRayDql4Fe4BJ5kcHUczMzJGCocy6jAblt3hPplI";
  if (p === "/api/personality-quiz/leads" && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user || !isStaff(user)) return sendJson(res, 403, { error: "Not allowed" });
    return sendJson(res, 200, readJson(PERSONALITY_LEADS_FILE, []));
  }
  if (p === "/api/personality-quiz/lead" && req.method === "POST") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const contact = await readJsonBody(req);
    contact.receivedAt = new Date().toISOString();
    const leads = readJson(PERSONALITY_LEADS_FILE, []);
    leads.unshift(contact);
    writeJson(PERSONALITY_LEADS_FILE, leads);

    if (contact.email) {
      updatePersonalityColumn(contact.email, contact.mbti || "", contact.standard || "", contact.archetype || "", contact.gender || "", contact.firstName, contact.lastName)
        .catch(e => console.error("[personality-quiz sheet sync]", e.message));
      (async () => {
        try {
          const accessToken = await getGoogleAccessToken();
          const personality = [
            contact.mbti ? `MBTI: ${contact.mbti} ${contact.standard || ""}`.trim() : "",
            contact.archetype ? `PRA: ${contact.archetype} ${contact.summary || ""}`.trim() : "",
          ].filter(Boolean).join(" ");
          const row = [contact.email || "", contact.firstName || "", contact.lastName || "", contact.phone || "", new Date().toLocaleString("en-US"), personality];
          await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${PERSONALITY_QUIZ_SHEET_ID}/values/${encodeURIComponent("'PERSONALITY QUIZ'!A1:F1")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
            { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [row] }) }
          );
        } catch (e) {
          console.error("[personality-quiz sheet append]", e.message);
        }
      })();
    }
    return sendJson(res, 200, { ok: true });
  }

  // ─── Personality Quiz admin — archetype/config editor ─────────────────
  // Same missing-in-production issue as /lead above: these existed only in
  // the local-dev root server.js. Ported here, admin-gated (the original
  // had NO auth check at all — anyone could rewrite every archetype).
  const PERSONALITY_CONFIG_FILE = "personality-quiz/config.json";
  if (p === "/api/personality-quiz/config") {
    if (req.method === "GET") {
      return sendJson(res, 200, readJson(PERSONALITY_CONFIG_FILE, {}));
    }
    if (req.method === "POST") {
      const user = getSessionUser(req);
      if (!user || !isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const cfg = await readJsonBody(req);
      if (!cfg.settings || !cfg.questions || !cfg.archetypes) return sendJson(res, 400, { error: "invalid config shape" });
      writeJson(PERSONALITY_CONFIG_FILE, cfg);
      return sendJson(res, 200, { ok: true });
    }
  }

  // Archetype images uploaded from the admin editor — same
  // filename-sanitizing + data-URL-decode approach as the original,
  // just written under DATA_DIR (see writeJson above) so an uploaded
  // image survives the next deploy instead of vanishing with the rest
  // of __dirname's git-checked-out code. Served back by the GET route
  // just below, since server.js's static-file fallback only ever looks
  // in __dirname and would never find a DATA_DIR-only file.
  if (p === "/api/personality-quiz/upload-image" && req.method === "POST") {
    const user = getSessionUser(req);
    if (!user || !isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
    try {
      const { filename, dataUrl } = await readJsonBody(req);
      const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || "");
      if (!filename || !m) return sendJson(res, 400, { error: "expected {filename, dataUrl}" });
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const dest = join(DATA_DIR, "personality-quiz", "images", safeName);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(m[2], "base64"));
      return sendJson(res, 200, { ok: true, url: `/personality-quiz/images/${safeName}` });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // Serves an uploaded archetype image — checks DATA_DIR first (where
  // uploads actually land, see above) and falls back to the git-bundled
  // copy in __dirname (e.g. images that shipped with the repo and were
  // never re-uploaded through the admin editor).
  const archetypeImageMatch = p.match(/^\/personality-quiz\/images\/([a-zA-Z0-9._-]+)$/);
  if (archetypeImageMatch && req.method === "GET") {
    const name = archetypeImageMatch[1];
    const volumePath = join(DATA_DIR, "personality-quiz", "images", name);
    const bundledPath = join(__dirname, "personality-quiz", "images", name);
    const filePath = existsSync(volumePath) ? volumePath : bundledPath;
    if (!existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return true; }
    const ext = name.split(".").pop().toLowerCase();
    const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(readFileSync(filePath));
    return true;
  }

  // Everything below requires a logged-in user.
  if (p.startsWith("/api/chat/") || p.startsWith("/api/admin/")) {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });

    // ─── Admin ────────────────────────────────────────────────────────────
    if (p === "/api/admin/users") {
      if (req.method === "GET") {
        if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
        const users = readJson(USERS_FILE, []);
        await syncStudentRoles(users);
        return sendJson(res, 200, { users: users.map(publicUser) });
      }
      if (req.method === "POST") {
        if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
        const { first, last, email, phone, password, role } = await readJsonBody(req);
        if (!first || !last || !email || !password) return sendJson(res, 400, { error: "first, last, email, password are required" });
        if (["user", "online", "gym", "coach", "admin", "admin2"].indexOf(role) === -1) return sendJson(res, 400, { error: "role must be 'user', 'online', 'gym', 'coach', 'admin', or 'admin2'" });
        const users = readJson(USERS_FILE, []);
        if (users.some(u => u.email.toLowerCase() === String(email).toLowerCase())) {
          return sendJson(res, 409, { error: "An account with that email already exists" });
        }
        const { salt, hash } = hashPassword(password);
        const newUser = {
          id: randomUUID(),
          first, last, email: String(email).toLowerCase(), phone: phone || "",
          passwordSalt: salt, passwordHash: hash,
          role,
          profilePictureFileId: null,
          ip: null, geo: null,
          createdAt: new Date().toISOString(),
        };
        users.push(newUser);
        writeJson(USERS_FILE, users);
        syncDefaultGroups();
        // Someone created straight from Admin Panel never went through
        // signup, so they'd otherwise have no App sheet row at all and
        // wouldn't show on the Strength Ninjas map. Add one now, TYPE
        // already set from their assigned role.
        upsertAppSheetRow({ first, last, email: newUser.email, phone, role }).catch(e => console.error("[APP sheet sync]", e.message));
        // Admin creating someone else's account — no session cookie set here,
        // unlike signup. They'll get their own session when they log in.
        return sendJson(res, 200, { ok: true, user: publicUser(newUser) });
      }
    }
    const roleMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
    if (roleMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { role } = await readJsonBody(req);
      if (["user", "online", "gym", "coach", "admin", "admin2"].indexOf(role) === -1) return sendJson(res, 400, { error: "role must be 'user', 'online', 'gym', 'coach', 'admin', or 'admin2'" });
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === roleMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      // The only guard left: an admin can't demote themselves out of
      // admin-level access — locking themselves out is unrecoverable
      // without going into the file by hand. Demoting/promoting anyone
      // else, including other admins, is otherwise allowed.
      if (target.id === user.id && !isAdmin({ role })) return sendJson(res, 400, { error: "Can't remove your own admin access" });
      target.role = role;
      writeJson(USERS_FILE, users);
      syncDefaultGroups();
      syncAppSheetRole(target).catch(e => console.error("[APP sheet role sync]", e.message));
      return sendJson(res, 200, { ok: true, user: publicUser(target) });
    }
    // Correct a name/email/phone typo directly (e.g. "Muros" vs the real
    // "Muro" — a real spelling mismatch that silently broke level lookups
    // matched by exact name elsewhere in this file). Any field left out of
    // the body is untouched; email changes are re-checked for uniqueness
    // since it's still the login identifier.
    const profileMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/profile$/);
    if (profileMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { first, last, email, phone } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === profileMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      if (first !== undefined) {
        if (!String(first).trim()) return sendJson(res, 400, { error: "First name can't be blank" });
        target.first = String(first).trim();
      }
      if (last !== undefined) {
        if (!String(last).trim()) return sendJson(res, 400, { error: "Last name can't be blank" });
        target.last = String(last).trim();
      }
      if (email !== undefined) {
        const normalized = String(email).trim().toLowerCase();
        if (!normalized) return sendJson(res, 400, { error: "Email can't be blank" });
        if (users.some(u => u.id !== target.id && u.email.toLowerCase() === normalized)) {
          return sendJson(res, 409, { error: "Another account already uses that email" });
        }
        target.email = normalized;
      }
      if (phone !== undefined) target.phone = String(phone).trim();
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, user: publicUser(target) });
    }
    const zoomLinkMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/zoom-link$/);
    if (zoomLinkMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { zoomLink } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === zoomLinkMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      target.zoomLink = zoomLink || "";
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, user: publicUser(target) });
    }
    const setPasswordMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
    if (setPasswordMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { password } = await readJsonBody(req);
      if (!password || password.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters" });
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === setPasswordMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      const { salt, hash } = hashPassword(password);
      target.passwordSalt = salt;
      target.passwordHash = hash;
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true });
    }
    const archiveMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/archived$/);
    if (archiveMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { archived } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === archiveMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      if (isAdmin(target)) return sendJson(res, 400, { error: "Can't archive an admin" });
      target.archived = !!archived;
      writeJson(USERS_FILE, users);
      syncDefaultGroups();
      // Archiving should boot them out right away, not just block future logins.
      if (target.archived) {
        const sessions = readJson(SESSIONS_FILE, {});
        Object.keys(sessions).forEach(token => { if (sessions[token].userId === target.id) delete sessions[token]; });
        writeJson(SESSIONS_FILE, sessions);
      }
      return sendJson(res, 200, { ok: true, user: publicUser(target) });
    }
    const physiqueNotifsMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/physique-checkin-notifs$/);
    if (physiqueNotifsMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { enabled } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === physiqueNotifsMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      target.physiqueCheckinNotifsEnabled = !!enabled;
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, user: publicUser(target) });
    }
    const hardDeleteMatch = p.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (hardDeleteMatch && req.method === "DELETE") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const targetId = hardDeleteMatch[1];
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === targetId);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      if (isAdmin(target)) return sendJson(res, 400, { error: "Can't delete an admin" });

      writeJson(USERS_FILE, users.filter(u => u.id !== targetId));
      syncDefaultGroups();

      const sessions = readJson(SESSIONS_FILE, {});
      Object.keys(sessions).forEach(token => { if (sessions[token].userId === targetId) delete sessions[token]; });
      writeJson(SESSIONS_FILE, sessions);

      const resets = readJson(RESETS_FILE, {});
      Object.keys(resets).forEach(token => { if (resets[token].userId === targetId) delete resets[token]; });
      writeJson(RESETS_FILE, resets);

      writeJson(PUSH_FILE, readJson(PUSH_FILE, []).filter(s => s.userId !== targetId));
      writeJson(FAVORITES_FILE, readJson(FAVORITES_FILE, []).filter(f => f.userId !== targetId));

      const protocols = readJson(TRAINING_PROTOCOLS_FILE, {});
      delete protocols[targetId];
      writeJson(TRAINING_PROTOCOLS_FILE, protocols);

      // DMs involving the deleted user have no one left to keep them for —
      // remove the conversation and its messages entirely. Group chats stay
      // alive for the remaining members; just drop the user from the
      // participant list and scrub any messages they personally sent.
      const convos = readJson(CONVOS_FILE, []);
      const dmIdsToRemove = convos.filter(c => c.type === "dm" && c.participantIds.includes(targetId)).map(c => c.id);
      const remainingConvos = convos
        .filter(c => !dmIdsToRemove.includes(c.id))
        .map(c => c.type === "group" ? { ...c, participantIds: c.participantIds.filter(id => id !== targetId) } : c);
      writeJson(CONVOS_FILE, remainingConvos);

      const messages = readJson(MESSAGES_FILE, []);
      const remainingMessages = messages.filter(m => !dmIdsToRemove.includes(m.conversationId) && m.senderId !== targetId);
      writeJson(MESSAGES_FILE, remainingMessages);

      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/admin/chat-config") {
      if (req.method === "GET") {
        if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
        const cfg = ensureVapidKeys();
        const { vapidPrivateKey, ...safe } = cfg;
        return sendJson(res, 200, safe);
      }
      if (req.method === "POST") {
        if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
        const { profilePhotosFolderId, chatImagesFolderId, chatVideosFolderId, trainingProtocolFolderId, trainingProtocolVideoLibraryFolderId, powerbaticsVideosFolderId, favoritesFolderId, intakeFormsFolderId, clientNotesFolderId, callRecordingsFolderId, bodyScanPhotosFolderId, nutritionPhotosFolderId, gifApiKey, appointments } = await readJsonBody(req);
        const cfg = getConfig();
        if (profilePhotosFolderId !== undefined) cfg.profilePhotosFolderId = profilePhotosFolderId;
        if (chatImagesFolderId !== undefined) cfg.chatImagesFolderId = chatImagesFolderId;
        if (chatVideosFolderId !== undefined) cfg.chatVideosFolderId = chatVideosFolderId;
        if (trainingProtocolFolderId !== undefined) cfg.trainingProtocolFolderId = trainingProtocolFolderId;
        if (trainingProtocolVideoLibraryFolderId !== undefined) cfg.trainingProtocolVideoLibraryFolderId = trainingProtocolVideoLibraryFolderId;
        if (powerbaticsVideosFolderId !== undefined) cfg.powerbaticsVideosFolderId = powerbaticsVideosFolderId;
        if (favoritesFolderId !== undefined) cfg.favoritesFolderId = favoritesFolderId;
        if (intakeFormsFolderId !== undefined) cfg.intakeFormsFolderId = intakeFormsFolderId;
        if (clientNotesFolderId !== undefined) cfg.clientNotesFolderId = clientNotesFolderId;
        if (callRecordingsFolderId !== undefined) cfg.callRecordingsFolderId = callRecordingsFolderId;
        if (bodyScanPhotosFolderId !== undefined) cfg.bodyScanPhotosFolderId = bodyScanPhotosFolderId;
        if (nutritionPhotosFolderId !== undefined) cfg.nutritionPhotosFolderId = nutritionPhotosFolderId;
        if (gifApiKey !== undefined) cfg.gifApiKey = gifApiKey;
        if (appointments !== undefined) cfg.appointments = { ...DEFAULT_APPOINTMENTS_CONFIG, ...cfg.appointments, ...appointments };
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ─── Gym schedule: dates blocked off from booking ──────────────────────
    // Global, not per-student — the Gym's 2 fixed daily slots are a shared
    // facility resource, so blocking a date (holiday, gym closure, etc.)
    // blocks it for every Gym client's booking, not just one person's.
    if (p === "/api/chat/gym-blocked-dates" && req.method === "GET") {
      return sendJson(res, 200, { dates: readJson(GYM_BLOCKED_DATES_FILE, []) });
    }
    if (p === "/api/admin/gym-blocked-dates" && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { dates } = await readJsonBody(req);
      if (!Array.isArray(dates) || dates.some(d => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
        return sendJson(res, 400, { error: "dates must be an array of 'YYYY-MM-DD' strings" });
      }
      writeJson(GYM_BLOCKED_DATES_FILE, Array.from(new Set(dates)).sort());
      return sendJson(res, 200, { ok: true });
    }

    // ─── Appointments: Google Calendar connection status ───────────────────
    if (p === "/api/admin/appointments-calendar-status" && req.method === "GET") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      if (!process.env.GOOGLE_REFRESH_TOKEN_PRA_CALENDAR) {
        return sendJson(res, 200, { connected: false });
      }
      try {
        const accessToken = await getCalendarAccessToken();
        const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const d = await r.json();
        if (!r.ok) return sendJson(res, 200, { connected: false, error: d.error?.message });
        return sendJson(res, 200, { connected: true, email: d.id });
      } catch (e) {
        return sendJson(res, 200, { connected: false, error: e.message });
      }
    }

    // ─── Contacts (coach-only visibility for regular users) ───────────────
    if (p === "/api/chat/contacts" && req.method === "GET") {
      // Everyone shows up in everyone's directory now — visibility here is
      // just "who exists," not "who can be messaged." canCreateDm() is the
      // actual gate on starting a new DM: a plain user/online/gym viewer
      // can still only reach admin/admin2 that way. Clicking any other
      // contact from this list instead opens a read-only profile popup
      // (see openContactProfile() in chat.html) — the shared auto-group
      // (syncDefaultGroups) plus whatever an admin starts with them
      // directly remain the only real conversations a client ever has.
      const users = readJson(USERS_FILE, []).filter(u => u.id !== user.id && !u.archived);
      return sendJson(res, 200, { contacts: users.map(publicUser) });
    }

    // ─── Users map ──────────────────────────────────────────────────────
    // Pulls live from the APP sheet on every open (not a local cache), so it
    // always reflects whatever's currently in the spreadsheet — including
    // rows edited by hand. Still deliberately narrow: first name + city/
    // region/country + coarse lat/lng — never IP, last name, email, or phone.
    if (p === "/api/chat/users-map" && req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      try {
        const points = await fetchUsersMapPoints();
        // Levels (including Super Level) are visible to everyone now — the
        // map is meant to double as a shared leaderboard. `last` name stays
        // staff-only — it only ever mattered for the staff-only levels-edit
        // affordance, and a non-staff viewer has no use for it.
        const visible = isStaff(user) ? points : points.map(pt => {
          const isSelf = nameKey(pt.first, pt.last) === nameKey(user.first, user.last);
          if (isSelf) return pt;
          const { last, ...rest } = pt;
          return rest;
        });
        return sendJson(res, 200, { points: visible });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ─── Single-person profile (chat sidebar → profile popup) ─────────────
    // A plain user/online/gym viewer can see everyone in the contacts
    // directory now, and clicking someone shows this read-only card —
    // avatar, role, location, training personality, and levels/Super Level
    // (editing levels still stays staff-only, see /api/chat/levels/update).
    // Any logged-in user may look up any other non-archived account.
    const chatProfileMatch = p.match(/^\/api\/chat\/profile\/([^/]+)$/);
    if (chatProfileMatch && req.method === "GET") {
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === chatProfileMatch[1] && !u.archived);
      if (!target) return sendJson(res, 404, { error: "Not found" });
      try {
        const profile = await fetchUserProfileCard(target);
        return sendJson(res, 200, { profile });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Same scrape, but just the parsed retreat list — the map only needs
    // this, not the full ~400KB content fragment.
    if (p === "/api/chat/upcoming-retreats" && req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      try {
        const { upcomingRetreats } = await fetchRetreatsPage();
        return sendJson(res, 200, { upcomingRetreats });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ─── Favorited media (coaches/admins only) ─────────────────────────────
    // Optional ?conversationId= scopes the list to one chat — used by the
    // "My Favorites" gallery opened from a specific thread's header, which
    // otherwise showed a coach's ENTIRE favorites list across every student
    // instead of just the one they had open. Omitted entirely by
    // loadFavorites() at page init (it just needs a global lookup of which
    // files are already favorited, to light up the right star icons — that
    // one isn't conversation-specific, so it stays unscoped on purpose.
    // Favorites saved before this field existed have no conversationId and
    // so won't match any scoped request — they still show up in the
    // unscoped global lookup, just not attributable to a specific thread.
    if (p === "/api/chat/favorites" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const all = readJson(FAVORITES_FILE, []);
      const conversationId = url.searchParams.get("conversationId");
      let mine = all.filter(f => f.userId === user.id);
      if (conversationId) mine = mine.filter(f => f.conversationId === conversationId);
      mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJson(res, 200, { favorites: mine });
    }
    if (p === "/api/chat/favorites" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const { driveFileId, name } = await readJsonBody(req);
      const trimmedName = String(name || "").trim();
      if (!driveFileId || !trimmedName) return sendJson(res, 400, { error: "driveFileId and name are required" });
      const cfg = getConfig();
      if (!cfg.favoritesFolderId) return sendJson(res, 400, { error: "Ask an admin to set the Favorited Media Drive Folder ID first." });
      // Same access check as the media-streaming proxy: the source file must
      // actually be attached to a message in a conversation this user is a
      // participant of — otherwise a client could pass an arbitrary Drive
      // file id and copy media it was never granted access to.
      const messages = readJson(MESSAGES_FILE, []);
      const srcMsg = messages.find(m => m.driveFileId === driveFileId && (m.type === "image" || m.type === "video"));
      if (!srcMsg) return sendJson(res, 404, { error: "Media not found" });
      const convos = readJson(CONVOS_FILE, []);
      const convo = convos.find(c => c.id === srcMsg.conversationId);
      if (!convo || !convo.participantIds.includes(user.id)) return sendJson(res, 403, { error: "Not a participant in that conversation" });
      try {
        const accessToken = await getDriveAccessToken();
        const ext = extFromMime(srcMsg.mimeType, srcMsg.name);
        const copy = await copyFileToFavorites({
          sourceFileId: driveFileId,
          name: trimmedName + ext,
          folderId: cfg.favoritesFolderId,
          ownerEmail: user.email,
          accessToken,
        });
        const all = readJson(FAVORITES_FILE, []);
        const record = {
          id: randomUUID(),
          userId: user.id, userEmail: user.email, userName: `${user.first} ${user.last}`,
          conversationId: srcMsg.conversationId,
          name: trimmedName,
          type: srcMsg.type,
          originalFileId: driveFileId,
          driveFileId: copy.id,
          webViewLink: copy.webViewLink,
          ownershipTransferred: copy.ownershipTransferred,
          createdAt: new Date().toISOString(),
        };
        all.push(record);
        writeJson(FAVORITES_FILE, all);
        return sendJson(res, 200, { favorite: record });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ─── Gym + Online skill levels (combined, searchable) ─────────────────
    // Levels are visible to any signed-in viewer, same as /api/chat/users-map
    // and /api/chat/levels/lookup — only `last` name stays staff-only (except
    // on your own entry), and only coaches/admins can edit (/levels/update).
    if (p === "/api/chat/levels" && req.method === "GET") {
      try {
        const people = await fetchAllLevels();
        const enriched = await enrichLevelsPeople(people);
        const visible = isStaff(user) ? enriched : enriched.map(p => {
          if (nameKey(p.first, p.last) === nameKey(user.first, user.last)) return p;
          const { last, ...rest } = p;
          return rest;
        });
        return sendJson(res, 200, { people: visible, categories: LEVELS_CATEGORIES });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Manual cache-bust for the Levels sheet (coach/admin) — fetchAllLevels()
    // caches for 10 minutes and only self-invalidates when the APP writes an
    // update (updateLevelsRow); an edit made directly in the spreadsheet
    // (e.g. deleting a duplicate row) doesn't touch that cache at all, so it
    // can keep serving stale data — including the duplicate rows a coach
    // just went and fixed — for up to 10 minutes with no visible reason why.
    // This just nulls the cache; the next /api/chat/levels or
    // /api/chat/users-map call re-fetches fresh from Sheets on its own.
    if (p === "/api/chat/levels/refresh" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      levelsCache = null;
      return sendJson(res, 200, { ok: true });
    }

    // Own levels, read-only — matched by the logged-in user's own name. Open
    // to everyone (it's always just your own data, never gated by name-
    // redaction since there's no last name to hide from yourself).
    if (p === "/api/chat/levels/me" && req.method === "GET") {
      try {
        const people = await fetchAllLevels();
        const entries = findLevelsEntries(people, user.first, user.last);
        return sendJson(res, 200, { entries, categories: LEVELS_CATEGORIES });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Lookup by arbitrary name — used by the Users Map popup, chat's
    // contact-profile popup, and profile.html's "My Levels" section. Levels
    // are visible to any signed-in viewer for anyone now; only the write
    // side (/api/chat/levels/update below) stays staff-only.
    if (p === "/api/chat/levels/lookup" && req.method === "GET") {
      const qFirst = url.searchParams.get("first");
      const qLast = url.searchParams.get("last");
      try {
        const people = await fetchAllLevels();
        const entries = findLevelsEntries(people, qFirst, qLast);
        return sendJson(res, 200, { entries, categories: LEVELS_CATEGORIES });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Coach/admin editing someone's levels — writes straight to the GYM or
    // ONLINE tab, matched by name (creates a new row if they're not on the
    // sheet yet).
    if (p === "/api/chat/levels/update" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { first, last, program, levels, team } = await readJsonBody(req);
      if (!first || !last) return sendJson(res, 400, { error: "first and last name required" });
      if (!["Gym", "Online"].includes(program)) return sendJson(res, 400, { error: "program must be 'Gym' or 'Online'" });
      try {
        await updateLevelsRow({ first, last, program, levels: levels || {}, team: !!team });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ─── Custom Training Protocol — Zapier/ClickFunnels-style ordered steps
    // (Drive video / uploaded image / text) attached to one client. Any
    // logged-in user can view their own; staff can view and edit anyone's.
    // Reserved literal sub-paths under /training-protocol/ that must NOT be
    // treated as a :targetUserId by the generic match below — without this
    // exclusion, GET /training-protocol/search-videos (and the two upload
    // routes) get silently swallowed here first (matching "search-videos"
    // etc. as if it were a user id) and never reach their real handlers
    // further down, which is why the video picker always came back empty.
    const TRAINING_PROTOCOL_RESERVED_SUBPATHS = ["upload-image", "upload-video", "search-videos"];
    const protocolMatch = p.match(/^\/api\/chat\/training-protocol\/([^/]+)$/);
    if (protocolMatch && !TRAINING_PROTOCOL_RESERVED_SUBPATHS.includes(protocolMatch[1])) {
      const targetUserId = protocolMatch[1];
      const canView = user.id === targetUserId || isStaff(user);
      if (!canView) return sendJson(res, 403, { error: "Not allowed" });

      if (req.method === "GET") {
        const all = readJson(TRAINING_PROTOCOLS_FILE, {});
        return sendJson(res, 200, { steps: all[targetUserId]?.steps || [] });
      }
      if (req.method === "POST") {
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
        const { steps } = await readJsonBody(req);
        if (!Array.isArray(steps)) return sendJson(res, 400, { error: "steps must be an array" });
        const all = readJson(TRAINING_PROTOCOLS_FILE, {});
        all[targetUserId] = { steps, updatedAt: new Date().toISOString(), updatedBy: user.id };
        writeJson(TRAINING_PROTOCOLS_FILE, all);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ─── Kickoff / Intake form ──────────────────────────────────────────
    // Client (or staff, filling it out for them) submits once; that submit
    // immediately locks it for EVERYONE, staff included — re-editing needs
    // an explicit /unlock first, so there's always a clear "who reopened
    // this and when" record rather than staff silently editing over a
    // client's original answers. Every successful submit also drops a
    // brand-new Doc into intakeFormsFolderId — a locked point-in-time
    // snapshot, not something later edits overwrite.
    const intakeMatch = p.match(/^\/api\/chat\/intake\/([^/]+)(\/unlock)?$/);
    if (intakeMatch) {
      const targetUserId = intakeMatch[1];
      const isUnlock = !!intakeMatch[2];
      const canView = user.id === targetUserId || isStaff(user);
      if (!canView) return sendJson(res, 403, { error: "Not allowed" });

      if (isUnlock) {
        if (req.method !== "POST") return sendJson(res, 404, { error: "Not found" });
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
        const all = readJson(INTAKE_FORMS_FILE, {});
        if (!all[targetUserId]) return sendJson(res, 404, { error: "No intake form submitted yet" });
        all[targetUserId].locked = false;
        all[targetUserId].unlockedBy = user.id;
        all[targetUserId].unlockedAt = new Date().toISOString();
        writeJson(INTAKE_FORMS_FILE, all);
        return sendJson(res, 200, { form: all[targetUserId] });
      }

      if (req.method === "GET") {
        const all = readJson(INTAKE_FORMS_FILE, {});
        return sendJson(res, 200, { form: all[targetUserId] || null });
      }
      if (req.method === "POST") {
        const all = readJson(INTAKE_FORMS_FILE, {});
        if (all[targetUserId]?.locked) return sendJson(res, 403, { error: "This form is locked — ask a coach or admin to unlock it before editing." });
        const { fields } = await readJsonBody(req);
        if (!fields || typeof fields !== "object") return sendJson(res, 400, { error: "fields required" });
        const submittedAt = new Date().toISOString();
        all[targetUserId] = { fields, locked: true, submittedBy: user.id, submittedAt };
        writeJson(INTAKE_FORMS_FILE, all);

        try {
          const allUsers = readJson(USERS_FILE, []);
          const target = allUsers.find(u => u.id === targetUserId);
          const clientName = target ? `${target.first} ${target.last}` : targetUserId;
          const cfg = getConfig();
          const accessToken = await getDriveAccessToken();
          const content = formatIntakeDoc(fields, clientName, `${user.first} ${user.last}`, submittedAt);
          const doc = await createOrUpdateDriveDoc({
            name: `${clientName} — Kickoff Intake — ${new Date(submittedAt).toLocaleDateString()}`,
            folderId: cfg.intakeFormsFolderId, content, accessToken,
          });
          all[targetUserId].driveDocId = doc.id;
          all[targetUserId].driveDocUrl = doc.webViewLink;
          writeJson(INTAKE_FORMS_FILE, all);
        } catch (e) {
          console.error("Intake form Drive doc failed:", e.message);
        }

        return sendJson(res, 200, { form: all[targetUserId] });
      }
    }

    // ─── Coach notes ────────────────────────────────────────────────────
    // Staff-only, per client, append-only log of structured session entries
    // (same fields as the ZOOM session table in the source doc — Zoom Date,
    // 1:1 Type, Sent Vids, Mindset, Coach, etc. — not a single freeform
    // blob). Each save adds a new dated entry (never overwrites a prior
    // one) and that same entry gets prepended to the client's single Drive
    // doc in clientNotesFolderId, so the doc always reads newest-first,
    // same as the in-app log.
    const notesMatch = p.match(/^\/api\/chat\/notes\/([^/]+)$/);
    if (notesMatch) {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const targetUserId = notesMatch[1];
      const all = readJson(NOTES_FILE, {});
      if (req.method === "GET") {
        return sendJson(res, 200, { notes: all[targetUserId] || null });
      }
      if (req.method === "POST") {
        const { fields } = await readJsonBody(req);
        if (!fields || typeof fields !== "object" || !Object.values(fields).some(v => String(v || "").trim())) {
          return sendJson(res, 400, { error: "At least one field is required" });
        }
        const createdAt = new Date().toISOString();
        const record = all[targetUserId] || { entries: [], driveDocId: null, driveDocUrl: null };
        record.entries.unshift({ fields, authorId: user.id, createdAt });
        all[targetUserId] = record;
        writeJson(NOTES_FILE, all);

        try {
          const allUsers = readJson(USERS_FILE, []);
          const target = allUsers.find(u => u.id === targetUserId);
          const clientName = target ? `${target.first} ${target.last}` : targetUserId;
          const cfg = getConfig();
          const accessToken = await getDriveAccessToken();
          const entryText = formatNoteEntry(fields, `${user.first} ${user.last}`, createdAt);
          const doc = record.driveDocId
            ? await createOrUpdateDriveDoc({ fileId: record.driveDocId, content: entryText + await exportDriveDocText(record.driveDocId, accessToken).catch(() => ""), accessToken })
            : await createOrUpdateDriveDoc({ name: `${clientName} — Client Notes`, folderId: cfg.clientNotesFolderId, content: entryText, accessToken });
          record.driveDocId = doc.id;
          record.driveDocUrl = doc.webViewLink;
          all[targetUserId] = record;
          writeJson(NOTES_FILE, all);
        } catch (e) {
          console.error("Client notes Drive doc failed:", e.message);
        }

        return sendJson(res, 200, { notes: all[targetUserId] });
      }
    }

    // Upload an image for one training-protocol step (staff only) — reuses
    // the same chat-image Drive folder and media-proxy endpoint messages do.
    if (p === "/api/chat/training-protocol/upload-image" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const cfg = getConfig();
      if (!cfg.trainingProtocolImagesFolderId) return sendJson(res, 400, { error: "Set a Training Protocol Images folder in Admin Settings first" });
      try {
        const accessToken = await getDriveAccessToken();
        const result = await new Promise((resolve, reject) => {
          const bb = Busboy({ headers: req.headers });
          let uploadPromise = null;
          bb.on("file", (name, stream, info) => {
            uploadPromise = uploadStreamToDrive(stream, {
              name: `Training Protocol ${Date.now()}${extFromMime(info.mimeType, info.filename)}`,
              mimeType: info.mimeType, folderId: cfg.trainingProtocolImagesFolderId, accessToken,
            });
          });
          bb.on("finish", async () => { try { resolve(uploadPromise ? await uploadPromise : null); } catch (e) { reject(e); } });
          bb.on("error", reject);
          req.pipe(bb);
        });
        if (!result) return sendJson(res, 400, { error: "No image received" });
        return sendJson(res, 200, { driveFileId: result.id });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Upload a NEW video for a training-protocol step — lands in the same
    // admin-configured folder search pulls from, so it's reusable/findable
    // for future clients' protocols too, not just this one step.
    if (p === "/api/chat/training-protocol/upload-video" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const cfg = getConfig();
      if (!cfg.trainingProtocolFolderId) return sendJson(res, 400, { error: "Set a Training Protocol Videos folder in Admin Settings first" });
      try {
        const accessToken = await getDriveAccessToken();
        const result = await new Promise((resolve, reject) => {
          const bb = Busboy({ headers: req.headers });
          let uploadPromise = null;
          let fileName = "";
          bb.on("file", (name, stream, info) => {
            fileName = info.filename || `Training Protocol Video ${Date.now()}`;
            uploadPromise = uploadStreamToDrive(stream, {
              name: fileName, mimeType: info.mimeType, folderId: cfg.trainingProtocolFolderId, accessToken,
            });
          });
          bb.on("finish", async () => { try { resolve(uploadPromise ? await uploadPromise : null); } catch (e) { reject(e); } });
          bb.on("error", reject);
          req.pipe(bb);
        });
        if (!result) return sendJson(res, 400, { error: "No video received" });
        return sendJson(res, 200, { driveFileId: result.id, name: result.name });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Search the admin-configured Drive folder for a video to attach as a
    // step, by filename.
    if (p === "/api/chat/training-protocol/search-videos" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const cfg = getConfig();
      if (!cfg.trainingProtocolVideoLibraryFolderId) return sendJson(res, 200, { files: [], needsConfig: true });
      try {
        const accessToken = await getDriveAccessToken();
        const q = (url.searchParams.get("q") || "").trim();
        const nameFilter = q ? ` and name contains '${q.replace(/'/g, "\\'")}'` : "";
        const folderIds = await getAllDescendantFolderIds(cfg.trainingProtocolVideoLibraryFolderId, accessToken);
        const parentsClause = folderIds.map(id => `'${id}' in parents`).join(" or ");
        const driveQuery = `(${parentsClause}) and mimeType contains 'video/' and trashed = false${nameFilter}`;
        // Small page size + pageToken pass-through — the picker loads more
        // as you scroll instead of this endpoint dumping a fixed 50-result
        // cap that just quietly ran out with no way to see anything past it.
        const pageToken = url.searchParams.get("pageToken") || "";
        const pageTokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(driveQuery)}&fields=nextPageToken,files(id,name)&pageSize=18${pageTokenParam}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const d = await r.json();
        return sendJson(res, 200, { files: d.files || [], nextPageToken: d.nextPageToken || null });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ─── VAPID public key ───────────────────────────────────────────────
    if (p === "/api/chat/vapid-public-key" && req.method === "GET") {
      const cfg = ensureVapidKeys();
      return sendJson(res, 200, { publicKey: cfg.vapidPublicKey });
    }

    // ─── GIF search (Giphy, if admin has configured a key) ────────────────
    if (p === "/api/chat/gifs" && req.method === "GET") {
      const cfg = getConfig();
      if (!cfg.gifApiKey) return sendJson(res, 200, { gifs: [], needsConfig: true });
      const q = url.searchParams.get("q") || "";
      const endpoint = q
        ? `https://api.giphy.com/v1/gifs/search?api_key=${cfg.gifApiKey}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${cfg.gifApiKey}&limit=24&rating=pg-13`;
      try {
        const r = await fetch(endpoint);
        const d = await r.json();
        const gifs = (d.data || []).map(g => ({
          id: g.id,
          preview: g.images?.fixed_width?.url || g.images?.original?.url,
          full: g.images?.original?.url,
        })).filter(g => g.preview && g.full);
        return sendJson(res, 200, { gifs });
      } catch (e) {
        return sendJson(res, 200, { gifs: [], error: e.message });
      }
    }

    // ─── Saved message templates (admin-authored, coach-sendable) ─────────
    if (p === "/api/chat/message-templates" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      let templates = readJson(MESSAGE_TEMPLATES_FILE, []);
      if (q) templates = templates.filter(t => t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q));
      templates.sort((a, b) => a.title.localeCompare(b.title));
      return sendJson(res, 200, { templates });
    }
    if (p === "/api/chat/message-templates" && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { title, text } = await readJsonBody(req);
      if (!String(title || "").trim() || !String(text || "").trim()) return sendJson(res, 400, { error: "Title and text are required" });
      const templates = readJson(MESSAGE_TEMPLATES_FILE, []);
      const template = { id: randomUUID(), title: title.trim(), text: text.trim(), createdAt: new Date().toISOString() };
      templates.push(template);
      writeJson(MESSAGE_TEMPLATES_FILE, templates);
      return sendJson(res, 200, { template });
    }
    const deleteTemplateMatch = p.match(/^\/api\/chat\/message-templates\/([^/]+)$/);
    if (deleteTemplateMatch && req.method === "DELETE") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const templates = readJson(MESSAGE_TEMPLATES_FILE, []);
      const next = templates.filter(t => t.id !== deleteTemplateMatch[1]);
      if (next.length === templates.length) return sendJson(res, 404, { error: "Template not found" });
      writeJson(MESSAGE_TEMPLATES_FILE, next);
      return sendJson(res, 200, { ok: true });
    }

    // ─── Saved training-protocol step text (admin-authored, coach-addable) ─
    if (p === "/api/chat/protocol-step-templates" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      let templates = readJson(PROTOCOL_STEP_TEMPLATES_FILE, []);
      if (q) templates = templates.filter(t => t.title.toLowerCase().includes(q) || t.text.toLowerCase().includes(q));
      templates.sort((a, b) => a.title.localeCompare(b.title));
      return sendJson(res, 200, { templates });
    }
    if (p === "/api/chat/protocol-step-templates" && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { title, text } = await readJsonBody(req);
      if (!String(title || "").trim() || !String(text || "").trim()) return sendJson(res, 400, { error: "Title and text are required" });
      const templates = readJson(PROTOCOL_STEP_TEMPLATES_FILE, []);
      const template = { id: randomUUID(), title: title.trim(), text: text.trim(), createdAt: new Date().toISOString() };
      templates.push(template);
      writeJson(PROTOCOL_STEP_TEMPLATES_FILE, templates);
      return sendJson(res, 200, { template });
    }
    const deleteProtocolTemplateMatch = p.match(/^\/api\/chat\/protocol-step-templates\/([^/]+)$/);
    if (deleteProtocolTemplateMatch && req.method === "DELETE") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const templates = readJson(PROTOCOL_STEP_TEMPLATES_FILE, []);
      const next = templates.filter(t => t.id !== deleteProtocolTemplateMatch[1]);
      if (next.length === templates.length) return sendJson(res, 404, { error: "Template not found" });
      writeJson(PROTOCOL_STEP_TEMPLATES_FILE, next);
      return sendJson(res, 200, { ok: true });
    }

    // ─── Whole reusable training protocols (named, full step graph) ────────
    // List is deliberately lightweight (no steps array) — a coach picking
    // from a menu of templates doesn't need every step's full content
    // downloaded up front, just enough to recognize which one they want.
    if (p === "/api/chat/protocol-templates" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const list = templates
        .map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, stepCount: t.steps.length }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, { templates: list });
    }
    if (p === "/api/chat/protocol-templates" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const { name, steps } = await readJsonBody(req);
      if (!String(name || "").trim()) return sendJson(res, 400, { error: "Name is required" });
      if (!Array.isArray(steps) || !steps.length) return sendJson(res, 400, { error: "Nothing to save — this protocol has no steps yet" });
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const template = { id: randomUUID(), name: name.trim(), steps, createdAt: new Date().toISOString(), savedBy: user.id };
      templates.push(template);
      writeJson(PROTOCOL_TEMPLATES_FILE, templates);
      return sendJson(res, 200, { template: { id: template.id, name: template.name, createdAt: template.createdAt, stepCount: steps.length } });
    }
    const protocolTemplateMatch = p.match(/^\/api\/chat\/protocol-templates\/([^/]+)$/);
    if (protocolTemplateMatch && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const template = readJson(PROTOCOL_TEMPLATES_FILE, []).find(t => t.id === protocolTemplateMatch[1]);
      if (!template) return sendJson(res, 404, { error: "Template not found" });
      return sendJson(res, 200, { template });
    }
    if (protocolTemplateMatch && req.method === "DELETE") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const next = templates.filter(t => t.id !== protocolTemplateMatch[1]);
      if (next.length === templates.length) return sendJson(res, 404, { error: "Template not found" });
      writeJson(PROTOCOL_TEMPLATES_FILE, next);
      return sendJson(res, 200, { ok: true });
    }

    // ─── Push subscribe ────────────────────────────────────────────────
    if (p === "/api/chat/push-subscribe" && req.method === "POST") {
      const { subscription } = await readJsonBody(req);
      if (!subscription) return sendJson(res, 400, { error: "subscription required" });
      const subs = readJson(PUSH_FILE, []).filter(s => s.subscription?.endpoint !== subscription.endpoint);
      subs.push({ userId: user.id, subscription, createdAt: new Date().toISOString() });
      writeJson(PUSH_FILE, subs);
      return sendJson(res, 200, { ok: true });
    }

    // Native push (Capacitor PushNotifications -> FCM/APNs) — same file,
    // distinguished from a browser Web Push subscription by shape (see
    // notifyParticipants).
    if (p === "/api/chat/push-subscribe-native" && req.method === "POST") {
      const { token, platform } = await readJsonBody(req);
      if (!token) return sendJson(res, 400, { error: "token required" });
      const subs = readJson(PUSH_FILE, []).filter(s => s.nativeToken?.token !== token);
      subs.push({ userId: user.id, nativeToken: { token, platform }, createdAt: new Date().toISOString() });
      writeJson(PUSH_FILE, subs);
      return sendJson(res, 200, { ok: true });
    }

    // Reported by the client whenever the conversation it's actively
    // showing changes (opened, closed, or the app itself backgrounds/
    // foregrounds) — see activeConversations/notifyParticipants above.
    if (p === "/api/chat/active-conversation" && req.method === "POST") {
      const { conversationId } = await readJsonBody(req);
      if (conversationId) activeConversations.set(user.id, { conversationId, updatedAt: Date.now() });
      else activeConversations.delete(user.id);
      return sendJson(res, 200, { ok: true });
    }

    // Staff-only diagnostic — reports whether Firebase is configured and
    // what's actually saved in PUSH_FILE, without needing Railway log
    // access at all. Nothing here is sensitive beyond ordinary staff view
    // (no raw tokens returned, just counts/platform/age).
    if (p === "/api/chat/push-debug" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Staff only" });
      const subs = readJson(PUSH_FILE, []);
      const native = subs.filter(s => s.nativeToken);
      const web = subs.filter(s => s.subscription);
      const users = readJson(USERS_FILE, []);
      const app = getFirebaseApp();
      return sendJson(res, 200, {
        firebaseConfigured: !!app,
        firebaseServiceAccountEnvVarSet: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
        firebaseInitError: app ? null : firebaseInitError,
        apnsConfigured: apnsConfigured(),
        totalSubscriptions: subs.length,
        nativeSubscriptions: native.map(s => ({
          user: users.find(u => u.id === s.userId)?.email || s.userId,
          platform: s.nativeToken.platform, createdAt: s.createdAt,
        })),
        webSubscriptionCount: web.length,
      });
    }

    // Sends a real push straight to every native token the CALLING user
    // has registered and reports exactly what Firebase said for each —
    // skips needing a second account, a real conversation, and Railway
    // log access just to see why a send is failing.
    if (p === "/api/chat/push-debug/test-send" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Staff only" });
      const fbApp = getFirebaseApp();
      const subs = readJson(PUSH_FILE, []);
      const mine = subs.filter(s => s.userId === user.id && s.nativeToken);
      if (!mine.length) return sendJson(res, 400, { error: "No native token registered for you — open the app and grant notification permission first" });
      const results = [];
      for (const sub of mine) {
        try {
          if (sub.nativeToken.platform === "ios") {
            if (!apnsConfigured()) throw Object.assign(new Error("APNs isn't configured — check APNS_KEY_ID / APNS_TEAM_ID / APNS_AUTH_KEY_B64"), { code: "apns-not-configured" });
            await sendApnsPush(sub.nativeToken.token, { title: "Test push", body: "If you see this, native push works.", conversationId: "" });
            results.push({ platform: "ios", ok: true });
          } else {
            if (!fbApp) throw Object.assign(new Error("Firebase isn't configured"), { code: firebaseInitError || "firebase-not-configured" });
            const id = await getMessaging(fbApp).send({
              token: sub.nativeToken.token,
              notification: { title: "Test push", body: "If you see this, native push works." },
              data: { conversationId: "" },
              android: { priority: "high", notification: { sound: "default", visibility: "public", icon: "ic_stat_notify", color: "#009BFF" } },
            });
            results.push({ platform: sub.nativeToken.platform, ok: true, messageId: id });
          }
        } catch (e) {
          results.push({ platform: sub.nativeToken.platform, ok: false, code: e.code || e.status, message: e.message });
        }
      }
      return sendJson(res, 200, { results });
    }

    // ─── Blocking / reporting (Guideline 1.2 UGC safety) ────────────────
    // A DM with someone you've blocked is filtered out of your own list
    // below (blockedUserIds) — group chats are left alone, since blocking is
    // a 1:1 concept here and yanking someone out of a shared training group
    // is a coach/admin action, not something blocking should silently do.
    if (p === "/api/chat/block" && req.method === "POST") {
      const { userId: blockedId } = await readJsonBody(req);
      if (!blockedId || blockedId === user.id) return sendJson(res, 400, { error: "Invalid user" });
      const blocks = readJson(BLOCKS_FILE, []);
      if (!blocks.some(b => b.blockerId === user.id && b.blockedId === blockedId)) {
        blocks.push({ id: randomUUID(), blockerId: user.id, blockedId, createdAt: new Date().toISOString() });
        writeJson(BLOCKS_FILE, blocks);
      }
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/chat/unblock" && req.method === "POST") {
      const { userId: blockedId } = await readJsonBody(req);
      const blocks = readJson(BLOCKS_FILE, []);
      writeJson(BLOCKS_FILE, blocks.filter(b => !(b.blockerId === user.id && b.blockedId === blockedId)));
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/chat/blocked" && req.method === "GET") {
      const blocks = readJson(BLOCKS_FILE, []).filter(b => b.blockerId === user.id);
      return sendJson(res, 200, { blockedUserIds: blocks.map(b => b.blockedId) });
    }
    // "flag objectionable content" — a message or a user, reported straight
    // to an admin (see notifyAdmins) plus kept in REPORTS_FILE as a durable
    // record. No auto-moderation action taken on the reported content itself
    // (blocking, not reporting, is what actually removes someone from your
    // own feed) — this just guarantees a human sees it fast.
    if (p === "/api/chat/report" && req.method === "POST") {
      const body = await readJsonBody(req);
      const type = body.type === "user" ? "user" : "message";
      if (!body.targetUserId) return sendJson(res, 400, { error: "targetUserId required" });
      const reports = readJson(REPORTS_FILE, []);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === body.targetUserId);
      let messageSnapshot = null;
      if (type === "message" && body.messageId) {
        const msg = readJson(MESSAGES_FILE, []).find(m => m.id === body.messageId);
        if (msg) messageSnapshot = { type: msg.type, text: msg.text || "", createdAt: msg.createdAt };
      }
      const report = {
        id: randomUUID(), type,
        reporterId: user.id, targetUserId: body.targetUserId,
        conversationId: body.conversationId || null, messageId: body.messageId || null,
        messageSnapshot, reason: (body.reason || "").slice(0, 500),
        createdAt: new Date().toISOString(),
      };
      reports.push(report);
      writeJson(REPORTS_FILE, reports);
      notifyAdmins({
        title: "Content reported",
        body: `${user.first} ${user.last} reported ${type === "user" ? "a user" : "a message"} from ${target ? `${target.first} ${target.last}` : "someone"}.`,
      }).catch(e => console.error("[report] admin notify failed:", e.message));
      return sendJson(res, 200, { ok: true });
    }

    // ─── Conversations ─────────────────────────────────────────────────
    if (p === "/api/chat/conversations" && req.method === "GET") {
      const blockedUserIds = new Set(readJson(BLOCKS_FILE, []).filter(b => b.blockerId === user.id).map(b => b.blockedId));
      const convos = readJson(CONVOS_FILE, []).filter(c => c.participantIds.includes(user.id))
        .filter(c => c.type !== "dm" || !c.participantIds.some(id => blockedUserIds.has(id)));
      const messages = readJson(MESSAGES_FILE, []);
      const users = readJson(USERS_FILE, []);
      const favoriteIds = new Set(user.favoriteConvoIds || []);
      const pinnedIds = new Set(user.pinnedConvoIds || []);
      const readState = user.readState || {};
      const enriched = convos.map(c => {
        const convoMsgs = messages.filter(m => m.conversationId === c.id);
        const last = convoMsgs[convoMsgs.length - 1];
        const lastReadAt = readState[c.id];
        const unreadCount = convoMsgs.filter(m => m.senderId !== user.id && (!lastReadAt || new Date(m.createdAt) > new Date(lastReadAt))).length;
        return {
          ...c,
          participants: c.participantIds.map(id => publicUser(users.find(u => u.id === id))).filter(Boolean)
            .sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`)),
          // status mirrors what the per-thread /messages endpoint attaches
          // (see computeMessageStatus) — needed here too so the sidebar can
          // show a read-receipt tick in the unread-count badge's slot for
          // your own last message, without a separate round-trip per convo.
          lastMessage: last ? { type: last.type, text: last.text || "", senderId: last.senderId, createdAt: last.createdAt, startISO: last.startISO, durationMinutes: last.durationMinutes, timezone: last.timezone, status: last.senderId === user.id ? computeMessageStatus(last, c, users) : undefined } : null,
          favorite: favoriteIds.has(c.id),
          pinned: pinnedIds.has(c.id),
          unreadCount,
          unread: unreadCount > 0,
        };
      }).sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.lastMessage?.createdAt || b.createdAt) - new Date(a.lastMessage?.createdAt || a.createdAt);
      });
      // A call ringing in a conversation that ISN'T the one currently open
      // still needs to surface somewhere -- this list is what's polled
      // regardless of which thread (if any) is open, so it's the one place
      // that can catch "someone's calling you" no matter where you are in
      // the app. Only ever the calls actually being offered to YOU (not
      // ones you started or already answered/declined).
      const myOpenConvoIds = new Set(convos.map(c => c.id));
      const incomingCall = readJson(CALLS_FILE, []).find(c =>
        c.status === "ringing" && myOpenConvoIds.has(c.conversationId) &&
        c.participantIds.includes(user.id) && !c.joinedIds.includes(user.id) && !c.declinedIds.includes(user.id)
      );
      return sendJson(res, 200, { conversations: enriched, incomingCall: incomingCall ? { ...publicCall(incomingCall), fromConversation: enriched.find(c => c.id === incomingCall.conversationId) } : null });
    }

    // A coach's "favorites" are effectively their caseload — a quick-access
    // shortlist distinct from the full contact/conversation list, which for
    // a coach with dozens of clients otherwise buries the handful they're
    // actively working with. Per-user (stored on the account, not the
    // conversation) since two coaches sharing a group shouldn't have to
    // share the same favorites too.
    const favoriteMatch = p.match(/^\/api\/chat\/conversations\/([^/]+)\/favorite$/);
    if (favoriteMatch && req.method === "POST") {
      const convoId = favoriteMatch[1];
      const convos = readJson(CONVOS_FILE, []);
      const convo = convos.find(c => c.id === convoId);
      if (!convo || !convo.participantIds.includes(user.id)) return sendJson(res, 404, { error: "Conversation not found" });
      const { favorite } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === user.id);
      target.favoriteConvoIds = target.favoriteConvoIds || [];
      const idx = target.favoriteConvoIds.indexOf(convoId);
      if (favorite && idx === -1) target.favoriteConvoIds.push(convoId);
      if (!favorite && idx !== -1) target.favoriteConvoIds.splice(idx, 1);
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, favorite: !!favorite });
    }

    const pinMatch = p.match(/^\/api\/chat\/conversations\/([^/]+)\/pin$/);
    if (pinMatch && req.method === "POST") {
      const convoId = pinMatch[1];
      const convos = readJson(CONVOS_FILE, []);
      const convo = convos.find(c => c.id === convoId);
      if (!convo || !convo.participantIds.includes(user.id)) return sendJson(res, 404, { error: "Conversation not found" });
      const { pinned } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === user.id);
      target.pinnedConvoIds = target.pinnedConvoIds || [];
      const idx = target.pinnedConvoIds.indexOf(convoId);
      if (pinned && idx === -1) target.pinnedConvoIds.push(convoId);
      if (!pinned && idx !== -1) target.pinnedConvoIds.splice(idx, 1);
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, pinned: !!pinned });
    }

    const readMatch = p.match(/^\/api\/chat\/conversations\/([^/]+)\/read$/);
    if (readMatch && req.method === "POST") {
      const convoId = readMatch[1];
      const convos = readJson(CONVOS_FILE, []);
      if (!convos.find(c => c.id === convoId && c.participantIds.includes(user.id))) {
        return sendJson(res, 404, { error: "Conversation not found" });
      }
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === user.id);
      target.readState = target.readState || {};
      target.readState[convoId] = new Date().toISOString();
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true });
    }

    if (p === "/api/chat/conversations" && req.method === "POST") {
      const body = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      let convo;
      if (body.type === "group") {
        if (!isStaff(user)) return sendJson(res, 403, { error: "Only coaches can create groups" });
        const ids = Array.from(new Set([user.id, ...(body.participantIds || [])]));
        if (ids.some(id => !users.some(u => u.id === id))) return sendJson(res, 400, { error: "Unknown participant" });
        convo = { id: randomUUID(), type: "group", name: body.name || "New Group", participantIds: ids, createdBy: user.id, createdAt: new Date().toISOString() };
      } else {
        const other = users.find(u => u.id === body.otherUserId);
        if (!other) return sendJson(res, 400, { error: "Unknown user" });
        // Written back when only a client could ever hit this — now a
        // coach can too (see canCreateDm's comment), and "you can only chat
        // with coaches" makes no sense said to a coach.
        if (!canCreateDm(user, other)) {
          return sendJson(res, 403, {
            error: isStaff(user)
              ? "Coaches reach students through the shared group chat, not a direct message."
              : "You can only chat with coaches.",
          });
        }
        const convos = readJson(CONVOS_FILE, []);
        const existing = convos.find(c => c.type === "dm" && c.participantIds.includes(user.id) && c.participantIds.includes(other.id));
        if (existing) return sendJson(res, 200, { conversation: existing });
        convo = { id: randomUUID(), type: "dm", participantIds: [user.id, other.id], createdBy: user.id, createdAt: new Date().toISOString() };
      }
      const convos = readJson(CONVOS_FILE, []);
      convos.push(convo);
      writeJson(CONVOS_FILE, convos);
      return sendJson(res, 200, { conversation: convo });
    }

    const convoIdMatch = p.match(/^\/api\/chat\/conversations\/([^/]+)(\/.*)?$/);
    if (convoIdMatch) {
      const convoId = convoIdMatch[1];
      const sub = convoIdMatch[2] || "";
      const convos = readJson(CONVOS_FILE, []);
      const convo = convos.find(c => c.id === convoId);
      if (!convo) return sendJson(res, 404, { error: "Conversation not found" });
      if (!convo.participantIds.includes(user.id)) return sendJson(res, 403, { error: "Not a participant" });

      // Delete the whole group — DMs aren't deletable this way since there's
      // no "everyone else" left to keep it around for.
      if (sub === "" && req.method === "DELETE") {
        if (convo.type !== "group") return sendJson(res, 400, { error: "Only groups can be deleted" });
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
        writeJson(CONVOS_FILE, convos.filter(c => c.id !== convoId));
        writeJson(MESSAGES_FILE, readJson(MESSAGES_FILE, []).filter(m => m.conversationId !== convoId));
        return sendJson(res, 200, { ok: true });
      }

      if (sub === "" && req.method === "PATCH") {
        if (convo.type !== "group") return sendJson(res, 400, { error: "Only groups can be renamed" });
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
        const { name } = await readJsonBody(req);
        const trimmed = String(name || "").trim();
        if (!trimmed) return sendJson(res, 400, { error: "Name can't be blank" });
        convo.name = trimmed;
        writeJson(CONVOS_FILE, convos);
        return sendJson(res, 200, { ok: true, conversation: convo });
      }

      if (sub === "/channel" && req.method === "POST") {
        if (convo.type !== "group") return sendJson(res, 400, { error: "Only groups can be marked as a channel" });
        if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
        const { isChannel } = await readJsonBody(req);
        if (isChannel) {
          const groupUsers = readJson(USERS_FILE, []);
          const hasClient = convo.participantIds.some(id => isClientRole(groupUsers.find(u => u.id === id)?.role));
          if (hasClient) return sendJson(res, 400, { error: "A group with online/gym clients in it can't be marked as a channel" });
        }
        convo.isChannel = !!isChannel;
        writeJson(CONVOS_FILE, convos);
        return sendJson(res, 200, { ok: true, conversation: convo });
      }

      if (sub === "/participants" && req.method === "POST") {
        if (convo.type !== "group") return sendJson(res, 400, { error: "Can only add members to a group" });
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
        const { participantIds } = await readJsonBody(req);
        const users = readJson(USERS_FILE, []);
        const toAdd = Array.from(new Set(participantIds || [])).filter(id => !convo.participantIds.includes(id));
        if (toAdd.some(id => !users.some(u => u.id === id))) return sendJson(res, 400, { error: "Unknown participant" });
        if (convo.isChannel && toAdd.some(id => isClientRole(users.find(u => u.id === id)?.role))) {
          return sendJson(res, 400, { error: "Can't add an online/gym client to a channel" });
        }
        convo.participantIds.push(...toAdd);
        writeJson(CONVOS_FILE, convos);
        return sendJson(res, 200, { ok: true, conversation: convo });
      }

      const removeParticipantMatch = sub.match(/^\/participants\/([^/]+)$/);
      if (removeParticipantMatch && req.method === "DELETE") {
        if (convo.type !== "group") return sendJson(res, 400, { error: "Can only remove members from a group" });
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
        const targetId = removeParticipantMatch[1];
        if (!convo.participantIds.includes(targetId)) return sendJson(res, 404, { error: "Not a member of this group" });
        convo.participantIds = convo.participantIds.filter(id => id !== targetId);
        writeJson(CONVOS_FILE, convos);
        return sendJson(res, 200, { ok: true, conversation: convo });
      }

      if (sub === "/typing" && req.method === "POST") {
        if (!typingUsers.has(convoId)) typingUsers.set(convoId, new Map());
        typingUsers.get(convoId).set(user.id, Date.now());
        return sendJson(res, 200, { ok: true });
      }

      if (sub === "/call" && req.method === "GET") {
        return sendJson(res, 200, { call: publicCall(findOpenCall(convoId)) });
      }

      if (sub === "/call/start" && req.method === "POST") {
        try {
          const existing = findOpenCall(convoId);
          if (existing) {
            const token = await createDailyMeetingToken(existing.dailyRoomName, user.id, `${user.first} ${user.last}`, user.id === existing.initiatorId);
            return sendJson(res, 200, { call: publicCall(existing), token });
          }
          const calls = readJson(CALLS_FILE, []);
          const room = await createDailyRoom(`call-${randomUUID()}`);
          const call = {
            id: randomUUID(), conversationId: convoId, initiatorId: user.id,
            participantIds: [...convo.participantIds], joinedIds: [user.id], declinedIds: [],
            status: "ringing", dailyRoomName: room.name, dailyRoomUrl: room.url,
            createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
          };
          calls.push(call);
          writeJson(CALLS_FILE, calls);
          const token = await createDailyMeetingToken(room.name, user.id, `${user.first} ${user.last}`, true);
          return sendJson(res, 200, { call: publicCall(call), token });
        } catch (e) {
          // A thrown error in here (bad/missing DAILY_API_KEY, Daily's API
          // down, etc.) would otherwise propagate all the way up to
          // server.js's request handler, which has no try/catch of its own
          // -- res.end() never gets called, and the client's fetch just
          // hangs indefinitely instead of failing visibly.
          console.error("[call/start]", e.message);
          return sendJson(res, 502, { error: "Could not start the call. Try again in a moment." });
        }
      }

      const callActionMatch = sub.match(/^\/call\/([^/]+)\/(accept|decline|end)$/);
      if (callActionMatch && req.method === "POST") {
        const [, callId, action] = callActionMatch;
        const calls = readJson(CALLS_FILE, []);
        const call = calls.find(c => c.id === callId && c.conversationId === convoId);
        if (!call) return sendJson(res, 404, { error: "Call not found" });

        if (action === "accept") {
          if (call.status !== "ringing" && call.status !== "active") return sendJson(res, 400, { error: "Call already ended" });
          if (!call.joinedIds.includes(user.id)) call.joinedIds.push(user.id);
          if (call.status === "ringing" && call.joinedIds.length >= 2) { call.status = "active"; call.startedAt = new Date().toISOString(); }
          writeJson(CALLS_FILE, calls);
          try {
            const token = await createDailyMeetingToken(call.dailyRoomName, user.id, `${user.first} ${user.last}`, user.id === call.initiatorId);
            return sendJson(res, 200, { call: publicCall(call), token });
          } catch (e) {
            console.error("[call/accept]", e.message);
            return sendJson(res, 502, { error: "Could not join the call. Try again in a moment." });
          }
        }

        if (action === "decline") {
          if (!call.declinedIds.includes(user.id)) call.declinedIds.push(user.id);
          // Everyone who was ever offered the call (everyone but whoever
          // started it) has now turned it down -- nobody's left who could
          // still pick up, so it's over, not just quieter.
          const targets = call.participantIds.filter(id => id !== call.initiatorId);
          if (call.status === "ringing" && targets.every(id => call.declinedIds.includes(id))) {
            call.status = "declined"; call.endedAt = new Date().toISOString();
            writeJson(CALLS_FILE, calls);
            createCallMessage(call); // never reached "active" -- always "missed", nothing to record
          } else {
            writeJson(CALLS_FILE, calls);
          }
          return sendJson(res, 200, { call: publicCall(call) });
        }

        if (action === "end") {
          const wasOpen = call.status === "ringing" || call.status === "active";
          if (wasOpen) {
            call.status = "ended"; call.endedAt = new Date().toISOString();
            writeJson(CALLS_FILE, calls);
            createCallMessage(call);
            if (call.startedAt) archiveCallRecording(call); // fire-and-forget, see its own comment
          } else {
            writeJson(CALLS_FILE, calls);
          }
          return sendJson(res, 200, { call: publicCall(call) });
        }
      }

      if (sub === "/messages" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 50;
        const before = url.searchParams.get("before");
        const allMessages = readJson(MESSAGES_FILE, []);
        let msgs = allMessages.filter(m => m.conversationId === convoId);
        if (before) msgs = msgs.filter(m => new Date(m.createdAt) < new Date(before));
        msgs = msgs.slice(-limit);

        // Read receipts, "delivered" half: this requester's client just
        // fetched these messages, so anything not their own just reached
        // them — stamp it. `msgs` holds the SAME object references as
        // allMessages (filter/slice don't clone), so mutating here and
        // writing allMessages back persists it correctly.
        let deliveryChanged = false;
        msgs.forEach(m => {
          if (m.senderId === user.id) return;
          m.deliveredTo = m.deliveredTo || [];
          if (!m.deliveredTo.includes(user.id)) { m.deliveredTo.push(user.id); deliveryChanged = true; }
        });
        if (deliveryChanged) writeJson(MESSAGES_FILE, allMessages);

        // "read" half + the sent/delivered/read status ticks show on your
        // OWN messages — computed here so the client just renders whatever
        // this says, rather than re-deriving it from raw deliveredTo/
        // readState data it would otherwise need every other participant's
        // user record for.
        const users = readJson(USERS_FILE, []);
        msgs = msgs.map(m => m.senderId === user.id ? { ...m, status: computeMessageStatus(m, convo, users) } : m);

        return sendJson(res, 200, { messages: msgs, typingUserIds: getTypingUserIds(convoId, user.id), activeCall: publicCall(findOpenCall(convoId)) });
      }

      if (sub === "/messages" && req.method === "POST") {
        // Blocking has to actually stop contact, not just hide the thread
        // from the blocker's own list above — otherwise the blocked person
        // could keep messaging into a conversation the blocker can no longer
        // even see. Group chats aren't blockable (see the block endpoint's
        // comment), so this only applies to DMs.
        if (convo.type === "dm") {
          const otherId = convo.participantIds.find(id => id !== user.id);
          const blockedByOther = readJson(BLOCKS_FILE, []).some(b => b.blockerId === otherId && b.blockedId === user.id);
          if (blockedByOther) return sendJson(res, 403, { error: "You can't message this person." });
        }
        const created = [];
        const ct = req.headers["content-type"] || "";
        if (ct.startsWith("multipart/form-data")) {
          const cfg = getConfig();
          const accessToken = await getDriveAccessToken();
          await new Promise((resolve, reject) => {
            const bb = Busboy({ headers: req.headers });
            const uploads = [];
            // In-app camera capture sends these two text fields ahead of the
            // video file itself (client controls FormData append order,
            // which busboy parses in stream order) — only present when the
            // student actually dragged a trim handle; a plain attach/paste
            // upload never sends them, so trimStart stays undefined and the
            // video branch below skips trimming entirely.
            let trimStart, trimEnd;
            bb.on("field", (name, val) => {
              if (name === "trimStart") trimStart = Number(val);
              if (name === "trimEnd") trimEnd = Number(val);
            });
            bb.on("file", (name, stream, info) => {
              const type = info.mimeType.startsWith("video/") ? "video" : "image";
              const ext = extFromMime(info.mimeType, info.filename);

              if (type === "image") {
                // Small enough to buffer whole — needed anyway to hand the
                // bytes to the vision model for the content guess before
                // naming the file.
                uploads.push((async () => {
                  try {
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    const label = await guessContentLabel(buffer, info.mimeType);
                    const baseName = `${user.first} ${user.last} ${label}`.toUpperCase();
                    const result = await uploadStreamToDrive(Readable.from(buffer), {
                      name: baseName + ext,
                      mimeType: info.mimeType,
                      folderId: cfg.chatImagesFolderId,
                      accessToken,
                    });
                    return { type, driveFileId: result.id, mimeType: info.mimeType, name: info.filename, driveFileName: baseName };
                  } catch (e) {
                    stream.resume();
                    return { error: e.message, name: info.filename };
                  }
                })());
              } else {
                // Video — this folder is intentionally uncompressed, so the
                // whole file is never held in memory: stream straight to a
                // temp file, pull one frame off disk via ffmpeg for the
                // content guess, then upload from disk.
                uploads.push((async () => {
                  const tempPath = join(tmpdir(), `chat-upload-${randomUUID()}${ext}`);
                  let trimmedPath = null;
                  try {
                    await new Promise((res, rej) => {
                      const ws = createWriteStream(tempPath);
                      stream.pipe(ws);
                      ws.on("finish", res);
                      ws.on("error", rej);
                      stream.on("error", rej);
                    });
                    // Everything downstream (frame guess, upload) reads from
                    // whichever path is "the file to use" — trimming, when
                    // requested, just swaps that path once up front instead
                    // of threading a condition through every step below.
                    let sourcePath = tempPath;
                    if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
                      trimmedPath = tempPath + "-trimmed.mp4";
                      try {
                        trimVideo(tempPath, trimmedPath, trimStart, trimEnd);
                        sourcePath = trimmedPath;
                      } catch (e) {
                        console.error("[trimVideo]", e.message);
                        // Fall back to the untrimmed capture rather than
                        // losing the student's clip entirely over a trim
                        // failure — trimmedPath stays null so cleanup below
                        // doesn't try to unlink a file that was never made.
                        trimmedPath = null;
                      }
                    }
                    const frame = extractVideoFrame(sourcePath);
                    const label = frame ? await guessContentLabel(frame, "image/jpeg") : "TRAINING VIDEO";
                    const baseName = `${user.first} ${user.last} ${label}`.toUpperCase();
                    const outExt = sourcePath === trimmedPath ? ".mp4" : ext;
                    const outMimeType = sourcePath === trimmedPath ? "video/mp4" : info.mimeType;
                    const result = await uploadStreamToDrive(createReadStream(sourcePath), {
                      name: baseName + outExt,
                      mimeType: outMimeType,
                      folderId: cfg.chatVideosFolderId,
                      accessToken,
                    });
                    return { type, driveFileId: result.id, mimeType: outMimeType, name: info.filename, driveFileName: baseName };
                  } catch (e) {
                    stream.resume();
                    return { error: e.message, name: info.filename };
                  } finally {
                    try { unlinkSync(tempPath); } catch {}
                    if (trimmedPath) { try { unlinkSync(trimmedPath); } catch {} }
                  }
                })());
              }
            });
            bb.on("finish", () => resolve(uploads));
            bb.on("error", reject);
            req.pipe(bb);
          }).then(async (uploads) => {
            const results = await Promise.all(uploads);
            const feedGroupId = results.length > 1 ? randomUUID() : null;
            const messages = readJson(MESSAGES_FILE, []);
            const now = Date.now();
            results.forEach((r, i) => {
              if (r.error) return;
              const msg = {
                id: randomUUID(), conversationId: convoId, senderId: user.id,
                type: r.type, driveFileId: r.driveFileId, mimeType: r.mimeType, name: r.name,
                // The "FIRST LAST BEST-GUESS" label already used as this
                // file's own Drive filename (see guessContentLabel above) —
                // carried onto the message record too so the favorite-star
                // popup can pre-fill a sensible name instead of a blank
                // field, without a round-trip to look it up.
                driveFileName: r.driveFileName,
                feedGroupId, createdAt: new Date(now + i).toISOString(),
              };
              messages.push(msg);
              created.push(msg);
            });
            writeJson(MESSAGES_FILE, messages);
          });
        } else if (req.headers["content-type"]?.includes("application/json") === false) {
          return sendJson(res, 400, { error: "text or gifUrl required" });
        } else {
          const body = await readJsonBody(req);
          const messages = readJson(MESSAGES_FILE, []);
          if (body.forwardMessageId) {
            // Forwarding just clones the source message's content fields into
            // this conversation — the sender must be a participant of
            // wherever the original lives, same access rule as any other
            // read, so this can't be used to pull a message out of a thread
            // you're not actually in.
            const src = messages.find(m => m.id === body.forwardMessageId);
            if (!src) return sendJson(res, 404, { error: "Original message not found" });
            const srcConvo = convos.find(c => c.id === src.conversationId);
            if (!srcConvo || !srcConvo.participantIds.includes(user.id)) return sendJson(res, 403, { error: "Not allowed to forward this message" });
            if (src.type === "appointment") return sendJson(res, 400, { error: "Appointments can't be forwarded" });
            const msg = {
              id: randomUUID(), conversationId: convoId, senderId: user.id,
              type: src.type, text: src.text,
              driveFileId: src.driveFileId, mimeType: src.mimeType, name: src.name, driveFileName: src.driveFileName,
              forwarded: true,
              createdAt: new Date().toISOString(),
            };
            messages.push(msg);
            writeJson(MESSAGES_FILE, messages);
            created.push(msg);
          } else {
            if (!body.text && !body.gifUrl) return sendJson(res, 400, { error: "text or gifUrl required" });
            const msg = {
              id: randomUUID(), conversationId: convoId, senderId: user.id,
              // driveFileId here references a file that ALREADY exists in
              // Drive (e.g. training-protocol.html's "Ask a Question" on a
              // step's video/image) rather than one just uploaded through
              // the multipart branch above — same shape of message either
              // way, just skipping the upload since there's nothing new to
              // upload.
              type: body.driveFileId ? (body.mediaType === "image" ? "image" : "video") : (body.gifUrl ? "gif" : "text"),
              text: body.gifUrl || body.text,
              driveFileId: body.driveFileId || undefined,
              replyToId: body.replyToId || undefined,
              // Timestamped video-reply notes (chat.html's video-reply modal) —
              // `text` above is still always sent too (a synthesized "[m:ss]
              // note" summary), so every other consumer of a plain message
              // (push notifications, sidebar preview, search, a normal reply
              // quoting this message) keeps working with zero special-casing;
              // this field only adds the richer inline-video-with-clickable-
              // timestamps rendering on top.
              videoNotes: Array.isArray(body.videoNotes) && body.videoNotes.length
                ? body.videoNotes.map(n => ({ time: Number(n.time) || 0, text: String(n.text || "").slice(0, 2000) }))
                : undefined,
              createdAt: new Date().toISOString(),
            };
            messages.push(msg);
            writeJson(MESSAGES_FILE, messages);
            created.push(msg);
          }
        }

        // Fire-and-forget push notification to the other participant(s).
        if (created.length) {
          const senderName = `${user.first} ${user.last}`;
          const first = created[0];
          const preview = first.type === "text" ? first.text
            : first.type === "gif" ? "sent a GIF"
            : created.length > 1 ? `sent ${created.length} ${first.type}s` : `sent a ${first.type}`;
          notifyParticipants(convoId, user.id, { title: senderName, body: preview, conversationId: convoId }).catch(() => {});
        }
        return sendJson(res, 200, { messages: created });
      }

      // ── Schedule an appointment (coach/admin only) ────────────────────────
      // Creates one calendar event (every recipient added as an attendee —
      // see createCalendarEvent's comment for why that's the correct
      // approach for "both calendars" without a per-client OAuth flow),
      // best-effort email + SMS to each recipient, and a chat message so it
      // shows up in the thread like any other message. Each side effect is
      // independent — a failed SMS shouldn't block the calendar invite or
      // the chat message, so each is caught and reported back individually
      // instead of one failure aborting the rest.
      //
      // Works in two kinds of conversation: a 1:1 DM (the other participant
      // is the sole recipient), or a group that has at least one "student"
      // member (every student in the group is a recipient — other staff
      // sitting in on the group chat aren't session attendees). The person
      // clicking "schedule" doesn't have to be the coach the event lands on
      // — an optional coachId lets any staff member in the room book it
      // directly onto a different coach/admin's calendar instead of their
      // own (e.g. Alexis scheduling a student onto Megan's calendar).
      if (sub === "/schedule" && req.method === "POST") {
        if (!isStaff(user)) return sendJson(res, 403, { error: "Only coaches can schedule appointments" });
        const { startISO, durationMinutes: reqDuration, coachId, coachIds: reqCoachIds } = await readJsonBody(req);
        if (!startISO) return sendJson(res, 400, { error: "startISO required" });
        const users = readJson(USERS_FILE, []);

        let recipients;
        if (convo.type === "dm") {
          const client = users.find(u => u.id === convo.participantIds.find(id => id !== user.id));
          if (!client) return sendJson(res, 404, { error: "Client not found" });
          recipients = [client];
        } else if (convo.type === "group") {
          recipients = convo.participantIds.map(id => users.find(u => u.id === id)).filter(u => u && isClientRole(u.role));
          if (!recipients.length) return sendJson(res, 400, { error: "This group has no online/gym clients to schedule with yet" });
        } else {
          return sendJson(res, 400, { error: "Scheduling is only available in 1:1 or group chats" });
        }

        // One or several coaches — the event goes on every selected coach's
        // own calendar (a separate event each, since Google Calendar has no
        // single-event-on-multiple-owners concept without a shared resource
        // calendar) so each of them sees it on their own schedule.
        const requestedCoachIds = (reqCoachIds && reqCoachIds.length) ? reqCoachIds : (coachId ? [coachId] : [user.id]);
        const coaches = [];
        for (const id of Array.from(new Set(requestedCoachIds))) {
          if (id === user.id) { coaches.push(user); continue; }
          const selected = users.find(u => u.id === id);
          if (!selected || !isStaff(selected)) return sendJson(res, 400, { error: "Selected coach not found" });
          coaches.push(selected);
        }
        if (!coaches.length) coaches.push(user);

        const cfg = getConfig();
        const apptCfg = cfg.appointments;
        // Gym clients train on the shared Gym 90 Minute Training Block
        // calendar, never on an individual coach's own calendar — a group
        // that includes ANY Gym-role client must book there too, even when
        // scheduled through this generic flow instead of the dedicated Gym
        // slot picker, or the event lands on the wrong calendar (and later
        // cancellation can't find it there either — see deleteCalendarEvent
        // call below in the DELETE handler). .some(), not .every() — a
        // mixed group (a Gym client sitting alongside Online/other roles)
        // still needs the Gym client to see it on the calendar they
        // actually train on; requiring every recipient to be Gym-role
        // meant any mixed group silently fell through to the per-coach/
        // Online path instead.
        const isGymBooking = recipients.some(r => r.role === "gym");
        if (isGymBooking && !apptCfg.gymCalendarId) {
          return sendJson(res, 400, { error: "Ask an admin to set the Gym 90 Minute Training Block calendar ID in Admin Settings first." });
        }
        const ANCHORAGE = "America/Anchorage";
        const eventTimezone = isGymBooking ? ANCHORAGE : apptCfg.timezone;
        const durationMinutes = reqDuration || apptCfg.defaultDurationMinutes || 15;
        const start = new Date(startISO);
        const end = new Date(start.getTime() + durationMinutes * 60000);
        const msgId = randomUUID();
        const coachName = coaches.map(c => `${c.first} ${c.last}`).join(" & ");
        const recipientNames = recipients.map(r => `${r.first} ${r.last}`).join(", ");
        const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: eventTimezone });
        const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: eventTimezone });

        const status = { calendar: null, email: null, sms: null };
        const googleEventIds = [], googleEventLinks = [];
        const calendarResults = [];
        for (const coach of coaches) {
          try {
            const ev = await createCalendarEvent({
              summary: `Training session — ${coachName} & ${recipientNames}`,
              description: `Scheduled from PRA Chat.`,
              startISO, durationMinutes,
              attendees: recipients.map(r => ({ email: r.email, name: `${r.first} ${r.last}` })),
              timezone: eventTimezone, calendarId: isGymBooking ? apptCfg.gymCalendarId : (coach.calendarEmail || coach.email),
            });
            googleEventIds.push(ev.id); googleEventLinks.push(ev.htmlLink);
            calendarResults.push({ ok: true });
          } catch (e) { calendarResults.push({ ok: false, error: e.message }); }
          if (isGymBooking) break; // one shared calendar — one event, not one per coach
        }
        status.calendar = calendarResults.length === 1 ? calendarResults[0]
          : calendarResults.every(r => r.ok) ? { ok: true }
          : { ok: false, error: `${calendarResults.filter(r => !r.ok).length}/${calendarResults.length} failed` };

        // Email/SMS/calendar-description all address each recipient by their
        // own name — sent per-recipient rather than one shared message, and
        // each one's date/time is formatted in THAT recipient's own stored
        // timezone (falling back to the admin-configured default for anyone
        // who hasn't been detected yet) rather than one fixed zone for
        // everyone.
        const evSummary = `Training session — ${coachName} & ${recipientNames}`;
        const evDescription = "Scheduled from PRA Chat.";
        const emailResults = [], smsResults = [];
        for (const client of recipients) {
          const clientTz = isGymBooking ? ANCHORAGE : (client.timezone || apptCfg.timezone);
          const clientDateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: clientTz });
          const clientTimeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: clientTz });
          const vars = { coachName, firstName: client.first, lastName: client.last, date: clientDateStr, time: clientTimeStr, duration: durationMinutes };
          if (apptCfg.emailEnabled) {
            try {
              const calButtons = addToCalendarButtonsHtml({ summary: evSummary, description: evDescription, start, end, timezone: clientTz, uid: msgId });
              const html = fillTemplate(apptCfg.emailBodyTemplate, vars) + calButtons;
              const ics = buildIcs({ summary: evSummary, description: evDescription, start, end, uid: msgId });
              await sendEmail(client.email, `${client.first} ${client.last}`, fillTemplate(apptCfg.emailSubjectTemplate, vars), html, [
                { filename: "invite.ics", mimeType: "text/calendar", content: ics },
              ]);
              emailResults.push({ ok: true });
            } catch (e) { emailResults.push({ ok: false, error: e.message }); }
          } else emailResults.push({ ok: false, error: "disabled" });

          if (apptCfg.smsEnabled) {
            try {
              await sendApptSms(client.email, client.phone, fillTemplate(apptCfg.smsTemplate, vars));
              smsResults.push({ ok: true });
            } catch (e) { smsResults.push({ ok: false, error: e.message }); }
          } else smsResults.push({ ok: false, error: "disabled" });
        }
        // One recipient (the DM/normal case) reports that recipient's own
        // result as-is; several recipients collapse to "all ok" or a count
        // of failures, since there's no single per-recipient row in the UI.
        function summarize(results) {
          if (results.length === 1) return results[0];
          const failed = results.filter(r => !r.ok && r.error !== "disabled");
          if (results.every(r => !r.ok && r.error === "disabled")) return { ok: false, error: "disabled" };
          if (!failed.length) return { ok: true };
          return { ok: false, error: `${failed.length}/${results.length} failed` };
        }
        status.email = summarize(emailResults);
        status.sms = summarize(smsResults);

        const messages = readJson(MESSAGES_FILE, []);
        const msg = {
          id: msgId, conversationId: convoId, senderId: user.id, type: "appointment",
          startISO, durationMinutes,
          // No forced timezone for a normal session — the chat header/bubble
          // render it in whichever viewer's own local device time, per
          // person. Gym slots are always shown as Anchorage time instead,
          // same as the dedicated Gym slot picker.
          timezone: isGymBooking ? ANCHORAGE : null,
          isGym: isGymBooking,
          clientIds: recipients.map(r => r.id),
          googleEventId: googleEventIds[0] || null, googleEventLink: googleEventLinks[0] || null,
          googleEventIds, googleEventLinks,
          createdAt: new Date().toISOString(),
        };
        messages.push(msg);
        writeJson(MESSAGES_FILE, messages);

        const appointments = readJson("chat_appointments.json", []);
        appointments.push({
          id: msg.id, conversationId: convoId,
          coachId: coaches[0].id, coachIds: coaches.map(c => c.id),
          clientIds: recipients.map(r => r.id), startISO, durationMinutes, isGym: isGymBooking,
          googleEventId: googleEventIds[0] || null, googleEventIds, status, createdAt: msg.createdAt,
        });
        writeJson("chat_appointments.json", appointments);

        notifyParticipants(convoId, user.id, { title: coachName, body: `📅 Session scheduled: ${dateStr} at ${timeStr}`, conversationId: convoId }).catch(() => {});

        return sendJson(res, 200, { message: msg, status });
      }

      // ── Gym schedule: fixed 4:15pm/6:15pm 90-min slots, Mon-Fri, always
      // Anchorage time regardless of who's booking or from where. Visible
      // to staff (booking on a client's behalf, same as normal scheduling)
      // and — unlike normal scheduling — to the Gym client themselves,
      // self-serve, in their own DM with a coach.
      if (sub === "/schedule-gym" && req.method === "POST") {
        if (convo.type !== "dm") return sendJson(res, 400, { error: "Gym scheduling is only available in a 1:1 chat" });
        const users = readJson(USERS_FILE, []);
        const otherId = convo.participantIds.find(id => id !== user.id);
        // Whichever participant actually has the "gym" role is the client,
        // regardless of which of the two people is the one booking.
        const clientCandidate = user.role === "gym" ? user : users.find(u => u.id === otherId && u.role === "gym");
        if (!clientCandidate) return sendJson(res, 400, { error: "This chat has no Gym client to schedule with" });
        if (!isStaff(user) && user.id !== clientCandidate.id) return sendJson(res, 403, { error: "Coaches, admins, or the Gym client themselves only" });

        const { date, slot } = await readJsonBody(req);
        const SLOTS = { "1615": "16:15", "1815": "18:15" };
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: "date must be 'YYYY-MM-DD'" });
        if (!SLOTS[slot]) return sendJson(res, 400, { error: "slot must be '1615' (4:15pm) or '1815' (6:15pm)" });

        const ANCHORAGE = "America/Anchorage";
        const weekday = weekdayInZone(date, ANCHORAGE);
        if (weekday === 0 || weekday === 6) return sendJson(res, 400, { error: "Gym sessions are only available Monday through Friday" });

        const blockedDates = readJson(GYM_BLOCKED_DATES_FILE, []);
        if (blockedDates.includes(date)) return sendJson(res, 400, { error: "That date isn't available for scheduling" });

        const start = zonedTimeToUtc(date, SLOTS[slot], ANCHORAGE);
        if (start.getTime() <= Date.now()) return sendJson(res, 400, { error: "That slot is in the past" });
        const durationMinutes = 90;
        const end = new Date(start.getTime() + durationMinutes * 60000);
        const startISO = start.toISOString();

        const cfg = getConfig();
        const apptCfg = cfg.appointments;
        if (!apptCfg.gymCalendarId) return sendJson(res, 400, { error: "Ask an admin to set the Gym 90 Minute Training Block calendar ID in Admin Settings first." });

        // Whoever's on the OTHER side of this DM from the client is treated
        // as "the coach" for the message/calendar description — could be
        // staff booking on the client's behalf, or (if the client booked it
        // themselves) whichever staff member they're chatting with.
        const coach = clientCandidate.id === user.id ? users.find(u => u.id === otherId) : user;
        const coachName = coach ? `${coach.first} ${coach.last}` : "PRA Gym";
        const msgId = randomUUID();

        const status = { calendar: null, email: null, sms: null };
        let googleEventId = null, googleEventLink = null;
        try {
          const ev = await createCalendarEvent({
            summary: `GYM 90 MINUTE TRAINING BLOCK — ${clientCandidate.first} ${clientCandidate.last}`,
            description: "Scheduled from PRA Chat.",
            startISO, durationMinutes,
            attendees: [{ email: clientCandidate.email, name: `${clientCandidate.first} ${clientCandidate.last}` }],
            timezone: ANCHORAGE, calendarId: apptCfg.gymCalendarId,
          });
          googleEventId = ev.id; googleEventLink = ev.htmlLink;
          status.calendar = { ok: true };
        } catch (e) { status.calendar = { ok: false, error: e.message }; }

        const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: ANCHORAGE });
        const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: ANCHORAGE });
        const vars = { coachName, firstName: clientCandidate.first, lastName: clientCandidate.last, date: dateStr, time: timeStr, duration: durationMinutes };
        const evSummary = `GYM 90 MINUTE TRAINING BLOCK — ${clientCandidate.first} ${clientCandidate.last}`;

        if (apptCfg.emailEnabled) {
          try {
            const calButtons = addToCalendarButtonsHtml({ summary: evSummary, description: "Scheduled from PRA Chat.", start, end, timezone: ANCHORAGE, uid: msgId });
            const html = fillTemplate(apptCfg.emailBodyTemplate, vars) + calButtons;
            const ics = buildIcs({ summary: evSummary, description: "Scheduled from PRA Chat.", start, end, uid: msgId });
            await sendEmail(clientCandidate.email, `${clientCandidate.first} ${clientCandidate.last}`, fillTemplate(apptCfg.emailSubjectTemplate, vars), html, [
              { filename: "invite.ics", mimeType: "text/calendar", content: ics },
            ]);
            status.email = { ok: true };
          } catch (e) { status.email = { ok: false, error: e.message }; }
        } else status.email = { ok: false, error: "disabled" };

        if (apptCfg.smsEnabled) {
          try {
            await sendApptSms(clientCandidate.email, clientCandidate.phone, fillTemplate(apptCfg.smsTemplate, vars));
            status.sms = { ok: true };
          } catch (e) { status.sms = { ok: false, error: e.message }; }
        } else status.sms = { ok: false, error: "disabled" };

        const messages = readJson(MESSAGES_FILE, []);
        const msg = {
          id: msgId, conversationId: convoId, senderId: user.id, type: "appointment",
          startISO, durationMinutes,
          timezone: ANCHORAGE, // Gym slots are always shown as Anchorage time, not per-viewer
          isGym: true, clientIds: [clientCandidate.id],
          googleEventId, googleEventLink, googleEventIds: googleEventId ? [googleEventId] : [], googleEventLinks: googleEventLink ? [googleEventLink] : [],
          createdAt: new Date().toISOString(),
        };
        messages.push(msg);
        writeJson(MESSAGES_FILE, messages);

        const appointments = readJson("chat_appointments.json", []);
        appointments.push({
          id: msg.id, conversationId: convoId,
          coachId: coach?.id || null, coachIds: coach ? [coach.id] : [],
          clientIds: [clientCandidate.id], startISO, durationMinutes,
          isGym: true,
          googleEventId, googleEventIds: googleEventId ? [googleEventId] : [], status, createdAt: msg.createdAt,
        });
        writeJson("chat_appointments.json", appointments);

        notifyParticipants(convoId, user.id, { title: coachName, body: `📅 Gym session scheduled: ${dateStr} at ${timeStr}`, conversationId: convoId }).catch(() => {});

        return sendJson(res, 200, { message: msg, status });
      }

      if (sub === "/search" && req.method === "GET") {
        const q = (url.searchParams.get("q") || "").toLowerCase();
        const msgs = readJson(MESSAGES_FILE, []).filter(m =>
          m.conversationId === convoId && m.type === "text" && m.text.toLowerCase().includes(q)
        );
        return sendJson(res, 200, { messages: msgs });
      }

      if (sub === "/media" && req.method === "GET") {
        const msgs = readJson(MESSAGES_FILE, []).filter(m =>
          m.conversationId === convoId && (m.type === "image" || m.type === "video")
        );
        return sendJson(res, 200, { media: msgs });
      }

      // ── Reactions (emoji tapbacks on any message, incl. images/video) ──
      // Multiple different emoji per user are allowed (Slack-style, not a
      // single iMessage-style tapback); re-sending the same emoji toggles it
      // off. Stored inline on the message so the existing /messages GET
      // already returns them, no separate fetch needed.
      const reactMatch = sub.match(/^\/messages\/([^/]+)\/react$/);
      if (reactMatch && req.method === "POST") {
        const messageId = reactMatch[1];
        const { emoji } = await readJsonBody(req);
        if (!emoji) return sendJson(res, 400, { error: "emoji required" });
        const messages = readJson(MESSAGES_FILE, []);
        const msg = messages.find(m => m.id === messageId && m.conversationId === convoId);
        if (!msg) return sendJson(res, 404, { error: "Message not found" });
        msg.reactions = msg.reactions || [];
        const idx = msg.reactions.findIndex(r => r.userId === user.id && r.emoji === emoji);
        if (idx >= 0) msg.reactions.splice(idx, 1);
        else msg.reactions.push({ userId: user.id, emoji });
        writeJson(MESSAGES_FILE, messages);
        return sendJson(res, 200, { reactions: msg.reactions });
      }

      // ── Delete / edit a message (staff only) ──────────────────────────────
      const msgMatch = sub.match(/^\/messages\/([^/]+)$/);
      if (msgMatch && (req.method === "DELETE" || req.method === "PATCH")) {
        const messageId = msgMatch[1];
        const messages = readJson(MESSAGES_FILE, []);
        const msgIdx = messages.findIndex(m => m.id === messageId && m.conversationId === convoId);
        if (msgIdx < 0) return sendJson(res, 404, { error: "Message not found" });
        if (req.method === "DELETE") {
          const deleted = messages[msgIdx];
          // Staff can cancel any appointment; a gym client can additionally
          // cancel their own Gym slot booking without needing staff — Gym
          // is the one appointment type visible/self-serviceable to clients
          // at all. Every other message type stays staff-only.
          const canCancelOwnGym = deleted.type === "appointment" && deleted.isGym && user.role === "gym" && deleted.clientIds?.includes(user.id);
          if (!isStaff(user) && !canCancelOwnGym) return sendJson(res, 403, { error: "Staff only" });
          messages.splice(msgIdx, 1);
          writeJson(MESSAGES_FILE, messages);

          if (deleted.type === "appointment") {
            const appointments = readJson("chat_appointments.json", []);
            const apptIdx = appointments.findIndex(a => a.id === deleted.id);
            const appt = apptIdx >= 0 ? appointments[apptIdx] : null;
            if (apptIdx >= 0) {
              appointments.splice(apptIdx, 1);
              writeJson("chat_appointments.json", appointments);
            }

            const users = readJson(USERS_FILE, []);
            const coachIds = appt?.coachIds || (appt?.coachId ? [appt.coachId] : (deleted.senderId ? [deleted.senderId] : []));
            const coaches = coachIds.map(id => users.find(u => u.id === id)).filter(Boolean);
            const coach = coaches[0] || null;

            // One event per coach (see the scheduling code's comment) — same
            // number of events as coaches, in the same order, so pair them
            // up by index; falls back to the single legacy googleEventId for
            // appointments booked before multi-coach scheduling existed.
            const eventIds = deleted.googleEventIds?.length ? deleted.googleEventIds : (deleted.googleEventId ? [deleted.googleEventId] : []);
            if (deleted.isGym) {
              // Gym events are always created on the shared gym calendar
              // (apptCfg.gymCalendarId), never on an individual coach's
              // calendar — deleting must target the same calendar it was
              // created on, or the delete call 404s against the wrong
              // calendar and the event silently survives.
              const gymCalendarId = getConfig().appointments.gymCalendarId;
              eventIds.forEach(eventId => {
                deleteCalendarEvent({ eventId, calendarId: gymCalendarId })
                  .catch(e => console.error("[appt cancel] gym calendar delete failed", e.message));
              });
            } else {
              eventIds.forEach((eventId, i) => {
                const evCoach = coaches[i] || coach;
                deleteCalendarEvent({ eventId, calendarId: evCoach?.calendarEmail || evCoach?.email })
                  .catch(e => console.error("[appt cancel] calendar delete failed", e.message));
              });
            }

            // Best-effort SMS notice, same channel bookings already use --
            // the calendar cancellation above already emails clients on its
            // own via sendUpdates=all.
            if (appt) {
              const cfg = getConfig();
              const apptCfg = cfg.appointments;
              const start = new Date(appt.startISO);
              const coachName = coaches.length ? coaches.map(c => `${c.first} ${c.last}`).join(" & ") : "your coach";
              const gymTz = appt.isGym ? "America/Anchorage" : null;
              if (apptCfg.smsEnabled) {
                (appt.clientIds || []).forEach(clientId => {
                  const client = users.find(u => u.id === clientId);
                  if (!client) return;
                  const clientTz = gymTz || client.timezone || apptCfg.timezone;
                  const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: clientTz });
                  const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: clientTz });
                  sendApptSms(client.email, client.phone, `Hi ${client.first}, your session with ${coachName} on ${dateStr} at ${timeStr} has been cancelled.`)
                    .catch(e => console.error("[appt cancel] SMS failed", e.message));
                });
              }
            }
          }

          return sendJson(res, 200, { ok: true });
        }
        // PATCH — edit text (always staff-only, unlike the DELETE path above)
        if (!isStaff(user)) return sendJson(res, 403, { error: "Staff only" });
        const { text } = await readJsonBody(req);
        if (!text) return sendJson(res, 400, { error: "text required" });
        if (messages[msgIdx].type !== "text") return sendJson(res, 400, { error: "Only text messages can be edited" });
        messages[msgIdx].text = text;
        messages[msgIdx].editedAt = new Date().toISOString();
        writeJson(MESSAGES_FILE, messages);
        return sendJson(res, 200, { message: messages[msgIdx] });
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  return false;
}
