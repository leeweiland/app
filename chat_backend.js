// chat_backend.js — WhatsApp-style chat: auth, users, conversations, messages,
// Drive-backed media (upload + streaming proxy), push notifications.
// Mounted from server.js: handleChatRequest(req, res, url) returns true if it
// handled the request, false to let server.js's existing routing continue.

import { readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { request as httpsRequest } from "https";
import { execFileSync } from "child_process";
import { Readable } from "stream";
import Busboy from "busboy";
import webPush from "web-push";
import { JSDOM } from "jsdom";

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
const MESSAGE_TEMPLATES_FILE = "chat_message_templates.json";
const PROTOCOL_STEP_TEMPLATES_FILE = "chat_protocol_step_templates.json";

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
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;

// One-time seed: the first boot after a Volume is attached, its mount dir is
// empty — copy each file's last git-committed version over as a starting
// point so existing users/conversations/etc. aren't wiped by the switch.
// No-ops on every boot after that (dest already exists), and no-ops entirely
// if no Volume is attached (DATA_DIR === __dirname, dest === seed).
function migrateDataFile(file) {
  const dest = join(DATA_DIR, file);
  const seed = join(__dirname, file);
  if (dest !== seed && !existsSync(dest) && existsSync(seed)) {
    writeFileSync(dest, readFileSync(seed));
  }
}
[
  "chat_users.json", "chat_sessions.json", "chat_conversations.json", "chat_messages.json",
  "chat_push_subscriptions.json", "chat_admin_config.json", "chat_password_resets.json",
  "chat_upload_counters.json", "chat_training_protocols.json", "chat_favorites.json",
  "chat_appointments.json", "chat_message_templates.json", "chat_protocol_step_templates.json",
].forEach(migrateDataFile);

function readJson(file, fallback) {
  const p = join(DATA_DIR, file);
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback; } catch { return fallback; }
}
function writeJson(file, data) {
  writeFileSync(join(DATA_DIR, file), JSON.stringify(data, null, 2), "utf8");
}

// Static, bundled-with-code content (not user data) — always read from the
// app's own directory, never the Volume. personality-quiz/config.json and
// leads.json aren't in the migrated data-file list and this server has no
// write path for either of them (that lives on a separate deployment), so
// routing them through DATA_DIR just meant they silently resolved to a
// path that never existed on the Volume, every archetype lookup failing
// and quietly falling back to the generic handstand silhouette.
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

function getConfig() {
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
    gifApiKey: "", vapidPublicKey: "", vapidPrivateKey: "",
    appointments: { ...DEFAULT_APPOINTMENTS_CONFIG },
  });
  ["profilePhotosFolderId", "chatImagesFolderId", "chatVideosFolderId", "trainingProtocolFolderId", "trainingProtocolVideoLibraryFolderId", "powerbaticsVideosFolderId", "favoritesFolderId"].forEach(k => {
    if (cfg[k]) cfg[k] = extractDriveFolderId(cfg[k]);
  });
  if (!cfg.trainingProtocolVideoLibraryFolderId) cfg.trainingProtocolVideoLibraryFolderId = "15dt68-wgb_BVoUw0dmlimBQFcwVf6KTX";
  if (!cfg.powerbaticsVideosFolderId) cfg.powerbaticsVideosFolderId = "1Es9fbvFRx7EuFiZu9t-X8pmZXGigf_wX";
  // No non-empty default to fall back to (unlike the two above) — just
  // ensures the key exists on configs saved before this feature existed, so
  // it isn't silently `undefined` and shows up as an empty field in the
  // admin panel rather than never appearing in the response at all.
  if (cfg.favoritesFolderId === undefined) cfg.favoritesFolderId = "";
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
function getSessionUser(req) {
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
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
  return true; // signals "handled" to the caller's fall-through check
}

// ── Google OAuth (Drive read/write) ─────────────────────────────────────
async function getDriveAccessToken() {
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
  return d.access_token;
}
// Same token also covers Sheets + Gmail scopes — reused for both below.
const getGoogleAccessToken = getDriveAccessToken;

// Append-or-update a signup's row in the shared "APP" tracking sheet, matched by
// email. Never allowed to break signup/reset flows — callers swallow its errors.
async function upsertAppSheetRow({ first, last, email, phone, ip, location }) {
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
  } else {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${APP_SHEET_TAB}'!A1:F1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: rowValues }),
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
  const leads = readAppJson(join("personality-quiz", "leads.json"), []);
  const lead = leads.find(l => (l.email || "").toLowerCase() === email.toLowerCase());
  return lead?.image || null;
}

// Build lookups from MBTI code, PRA title, and 16P standard name → {male, female} image URLs.
// All keys are normalized for case-insensitive matching.
function buildArchetypeImageMaps() {
  const cfg = readAppJson(join("personality-quiz", "config.json"), {});
  const byCode = {}, byTitle = {}, byStandard = {};
  for (const [code, arch] of Object.entries(cfg.archetypes || {})) {
    if (!arch.images) continue;
    const entry = { male: arch.images.male || null, female: arch.images.female || arch.images.male || null };
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
    let geo = ip ? await geolocateIpCached(ip) : null;
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
    const archetypeImage =
      pick(archetypeMaps.byTitle[(praPersona || "").toLowerCase()]) ||
      pick(archetypeMaps.byCode[(mbtiCode || "").toUpperCase()]) ||
      pick(archetypeMaps.byStandard[(sheetPersona16p || "").toLowerCase()]) ||
      getLatestArchetypeImage(email) ||
      null;

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
    const normalizedSheetType = (sheetType || "").trim().toLowerCase();
    const sheetRole = ["admin", "coach", "student", "user"].includes(normalizedSheetType) ? normalizedSheetType : null;

    points.push({
      first,
      profilePictureFileId: localUser?.profilePictureFileId || null,
      archetypeImage,
      role: sheetRole || "user",
      lat: geo.lat, lng: geo.lng,
      city: geo.city, region: geo.region, country: geo.country,
      levels: findLevelsEntries(levelsPeople, first, last),
    });
  }
  return points;
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

// ── Student eligibility ─────────────────────────────────────────────────
// A plain "user" account is treated as a "student" once their name shows up
// in either sales sheet (they've actually signed up for online or gym
// training) — as long as they aren't on the shared blacklist, checked two
// ways: the dedicated BLACKLIST tab, and a "BLACKLIST" marker some rows
// carry directly in their own Status column instead.
const STUDENT_SHEET_TABS = ["ONLINE KICKOFF / BUYERS", "GYM KICKOFF / BUYERS"];
const STUDENT_BLACKLIST_TAB = "BLACKLIST ONLINE & GYM";
function nameKey(first, last) {
  return `${String(first || "").trim().toLowerCase()}|${String(last || "").trim().toLowerCase()}`;
}
let studentEligibilityCache = null; // { at, eligible: Set<nameKey> } — 10-minute cache, same idea as the levels cache
async function fetchStudentEligibility() {
  if (studentEligibilityCache && Date.now() - studentEligibilityCache.at < 10 * 60 * 1000) return studentEligibilityCache.eligible;
  const accessToken = await getGoogleAccessToken();
  async function fetchTab(tabName, range) {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${APP_SHEET_ID}/values/${encodeURIComponent(`'${tabName}'!${range}`)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const d = await r.json();
    return (d.values || []).slice(1); // drop header row
  }
  const [blacklistRows, ...tabRows] = await Promise.all([
    fetchTab(STUDENT_BLACKLIST_TAB, "A1:B"),
    ...STUDENT_SHEET_TABS.map(t => fetchTab(t, "A1:E")),
  ]);
  const blacklisted = new Set(blacklistRows.filter(([first, last]) => first || last).map(([first, last]) => nameKey(first, last)));
  const eligible = new Set();
  tabRows.forEach(rows => {
    rows.forEach(([first, last, , , status]) => {
      if (!first && !last) return;
      const key = nameKey(first, last);
      if (blacklisted.has(key)) return;
      if (String(status || "").toUpperCase().includes("BLACKLIST")) return;
      eligible.add(key);
    });
  });
  studentEligibilityCache = { at: Date.now(), eligible };
  return eligible;
}
// Auto-promotes any plain "user" whose name is now sheet-eligible to
// "student" — a manual admin override to any other role always takes
// precedence going forward, since this only ever touches accounts still
// sitting at the plain "user" default.
async function syncStudentRoles(users) {
  try {
    const eligible = await fetchStudentEligibility();
    let changed = false;
    users.forEach(u => {
      if (u.role === "user" && eligible.has(nameKey(u.first, u.last))) { u.role = "student"; changed = true; }
    });
    if (changed) writeJson(USERS_FILE, users);
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
        const vars = { coachName, firstName: client.first, lastName: client.last, date: dateStr, time: timeStr, duration: appt.durationMinutes };
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
                startISO: appt.startISO, durationMinutes: appt.durationMinutes, timezone: apptCfg.timezone,
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

// ── Auto-labeling uploads: "FIRST LAST BEST-GUESS-OF-CONTENT" ──────────────
// Chat and body/move-scan uploads land in Drive named after who sent them
// and a short AI guess at what's actually in the shot (e.g. "LEE WEILAND
// HANDSTAND HOLD") instead of a bare sequence number — makes the raw Drive
// folders actually browsable/searchable later, matching how the existing
// training-footage library is already named by the coaches themselves.
const FFMPEG_EXE = join(__dirname, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe");

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
function uploadStreamToDrive(fileStream, { name, mimeType, folderId, accessToken }) {
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
async function notifyParticipants(conversationId, excludeUserId, payload) {
  const convos = readJson(CONVOS_FILE, []);
  const convo = convos.find(c => c.id === conversationId);
  if (!convo) return;
  const subs = readJson(PUSH_FILE, []);
  const targets = subs.filter(s => convo.participantIds.includes(s.userId) && s.userId !== excludeUserId);
  ensureVapidKeys();
  for (const target of targets) {
    try {
      await webPush.sendNotification(target.subscription, JSON.stringify(payload));
    } catch (e) {
      // Subscription likely expired/revoked — drop it silently.
      if (e.statusCode === 404 || e.statusCode === 410) {
        const remaining = readJson(PUSH_FILE, []).filter(s => s.subscription.endpoint !== target.subscription.endpoint);
        writeJson(PUSH_FILE, remaining);
      }
    }
  }
}

// ── Access rules ─────────────────────────────────────────────────────────
// admin2 has every admin capability except the Admin Panel page itself
// (that page's own access gate stays hardcoded to "admin" — see
// admin-panel.html's init()). Every other admin-only check in this file
// goes through isAdmin() so admin2 gets full parity everywhere else.
function isAdmin(user) { return user.role === "admin" || user.role === "admin2"; }
function isStaff(user) { return user.role === "coach" || isAdmin(user); }

function canCreateDm(creator, otherUser) {
  // Either side being staff is enough — students can only ever reach a
  // coach/admin, and staff can reach anyone (including each other).
  return isStaff(creator) || isStaff(otherUser);
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

    const { first, last, email, phone, password } = fields;
    if (!first || !last || !email || !password) return sendJson(res, 400, { error: "first, last, email, password are required" });

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
    };
    users.push(user);
    writeJson(USERS_FILE, users);
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
    writeJson(USERS_FILE, users);
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
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
  // flip a client between student/user or archive/unarchive them right from
  // the chat, without needing Admin Panel access. Deliberately narrower than
  // the admin panel's own role/archive endpoints: only allows the
  // student<->user swap (never promoting to coach/admin/admin2) and only
  // targets someone who's currently a student or user, so a coach can never
  // touch a staff account through this path.
  const quickRoleMatch = p.match(/^\/api\/chat\/users\/([^/]+)\/role$/);
  if (quickRoleMatch && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isStaff(me)) return sendJson(res, 403, { error: "Coaches and admins only" });
    const { role } = await readJsonBody(req);
    if (!["student", "user"].includes(role)) return sendJson(res, 400, { error: "role must be 'student' or 'user'" });
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === quickRoleMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    if (!["student", "user"].includes(target.role)) return sendJson(res, 400, { error: "Can only switch between student and user this way" });
    target.role = role;
    writeJson(USERS_FILE, users);
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
    if (!["student", "user"].includes(target.role)) return sendJson(res, 400, { error: "Can only archive a student or user this way" });
    target.archived = !!archived;
    writeJson(USERS_FILE, users);
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
          res.writeHead(driveRes.statusCode, passHeaders);
          driveRes.pipe(res);
          driveRes.on("end", resolve);
        });
        driveReq.on("error", reject);
        driveReq.end();
      });
    } catch (e) {
      res.writeHead(500); res.end("Media fetch failed: " + e.message);
    }
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
        if (!["user", "student", "coach", "admin", "admin2"].includes(role)) return sendJson(res, 400, { error: "role must be 'user', 'student', 'coach', 'admin', or 'admin2'" });
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
        // Admin creating someone else's account — no session cookie set here,
        // unlike signup. They'll get their own session when they log in.
        return sendJson(res, 200, { ok: true, user: publicUser(newUser) });
      }
    }
    const roleMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
    if (roleMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { role } = await readJsonBody(req);
      if (!["user", "student", "coach", "admin", "admin2"].includes(role)) return sendJson(res, 400, { error: "role must be 'user', 'student', 'coach', 'admin', or 'admin2'" });
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
      // Archiving should boot them out right away, not just block future logins.
      if (target.archived) {
        const sessions = readJson(SESSIONS_FILE, {});
        Object.keys(sessions).forEach(token => { if (sessions[token].userId === target.id) delete sessions[token]; });
        writeJson(SESSIONS_FILE, sessions);
      }
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
        const { profilePhotosFolderId, chatImagesFolderId, chatVideosFolderId, trainingProtocolFolderId, trainingProtocolVideoLibraryFolderId, powerbaticsVideosFolderId, favoritesFolderId, gifApiKey, appointments } = await readJsonBody(req);
        const cfg = getConfig();
        if (profilePhotosFolderId !== undefined) cfg.profilePhotosFolderId = profilePhotosFolderId;
        if (chatImagesFolderId !== undefined) cfg.chatImagesFolderId = chatImagesFolderId;
        if (chatVideosFolderId !== undefined) cfg.chatVideosFolderId = chatVideosFolderId;
        if (trainingProtocolFolderId !== undefined) cfg.trainingProtocolFolderId = trainingProtocolFolderId;
        if (trainingProtocolVideoLibraryFolderId !== undefined) cfg.trainingProtocolVideoLibraryFolderId = trainingProtocolVideoLibraryFolderId;
        if (powerbaticsVideosFolderId !== undefined) cfg.powerbaticsVideosFolderId = powerbaticsVideosFolderId;
        if (favoritesFolderId !== undefined) cfg.favoritesFolderId = favoritesFolderId;
        if (gifApiKey !== undefined) cfg.gifApiKey = gifApiKey;
        if (appointments !== undefined) cfg.appointments = { ...DEFAULT_APPOINTMENTS_CONFIG, ...cfg.appointments, ...appointments };
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true });
      }
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
      const users = readJson(USERS_FILE, []).filter(u => u.id !== user.id && !u.archived);
      const visible = isStaff(user) ? users : users.filter(isStaff);
      return sendJson(res, 200, { contacts: visible.map(publicUser) });
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
        return sendJson(res, 200, { points });
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
    if (p === "/api/chat/levels" && req.method === "GET") {
      try {
        const people = await fetchAllLevels();
        return sendJson(res, 200, { people, categories: LEVELS_CATEGORIES });
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

    // Own levels, read-only — matched by the logged-in user's own name.
    if (p === "/api/chat/levels/me" && req.method === "GET") {
      try {
        const people = await fetchAllLevels();
        const entries = findLevelsEntries(people, user.first, user.last);
        return sendJson(res, 200, { entries, categories: LEVELS_CATEGORIES });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Lookup by arbitrary name — used by the Users Map popup and by coaches
    // prefilling the edit-levels panel from chat. Any logged-in user can
    // call this (the map already shows first names + rough location to
    // everyone; this is no more sensitive than that).
    if (p === "/api/chat/levels/lookup" && req.method === "GET") {
      try {
        const people = await fetchAllLevels();
        const entries = findLevelsEntries(people, url.searchParams.get("first"), url.searchParams.get("last"));
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
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(driveQuery)}&fields=files(id,name)&pageSize=50`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const d = await r.json();
        return sendJson(res, 200, { files: d.files || [] });
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

    // ─── Push subscribe ────────────────────────────────────────────────
    if (p === "/api/chat/push-subscribe" && req.method === "POST") {
      const { subscription } = await readJsonBody(req);
      if (!subscription) return sendJson(res, 400, { error: "subscription required" });
      const subs = readJson(PUSH_FILE, []).filter(s => s.subscription.endpoint !== subscription.endpoint);
      subs.push({ userId: user.id, subscription, createdAt: new Date().toISOString() });
      writeJson(PUSH_FILE, subs);
      return sendJson(res, 200, { ok: true });
    }

    // ─── Conversations ─────────────────────────────────────────────────
    if (p === "/api/chat/conversations" && req.method === "GET") {
      const convos = readJson(CONVOS_FILE, []).filter(c => c.participantIds.includes(user.id));
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
          participants: c.participantIds.map(id => publicUser(users.find(u => u.id === id))).filter(Boolean),
          lastMessage: last ? { type: last.type, text: last.text || "", senderId: last.senderId, createdAt: last.createdAt, startISO: last.startISO, durationMinutes: last.durationMinutes, timezone: last.timezone } : null,
          favorite: favoriteIds.has(c.id),
          pinned: pinnedIds.has(c.id),
          unreadCount,
          unread: unreadCount > 0,
        };
      }).sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.lastMessage?.createdAt || b.createdAt) - new Date(a.lastMessage?.createdAt || a.createdAt);
      });
      return sendJson(res, 200, { conversations: enriched });
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
        if (!canCreateDm(user, other)) return sendJson(res, 403, { error: "You can only chat with coaches" });
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
          const hasStudent = convo.participantIds.some(id => groupUsers.find(u => u.id === id)?.role === "student");
          if (hasStudent) return sendJson(res, 400, { error: "A group with students in it can't be marked as a channel" });
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
        if (convo.isChannel && toAdd.some(id => users.find(u => u.id === id)?.role === "student")) {
          return sendJson(res, 400, { error: "Can't add a student to a channel" });
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

      if (sub === "/messages" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 50;
        const before = url.searchParams.get("before");
        let msgs = readJson(MESSAGES_FILE, []).filter(m => m.conversationId === convoId);
        if (before) msgs = msgs.filter(m => new Date(m.createdAt) < new Date(before));
        msgs = msgs.slice(-limit);
        return sendJson(res, 200, { messages: msgs });
      }

      if (sub === "/messages" && req.method === "POST") {
        const created = [];
        const ct = req.headers["content-type"] || "";
        if (ct.startsWith("multipart/form-data")) {
          const cfg = getConfig();
          const accessToken = await getDriveAccessToken();
          await new Promise((resolve, reject) => {
            const bb = Busboy({ headers: req.headers });
            const uploads = [];
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
                  try {
                    await new Promise((res, rej) => {
                      const ws = createWriteStream(tempPath);
                      stream.pipe(ws);
                      ws.on("finish", res);
                      ws.on("error", rej);
                      stream.on("error", rej);
                    });
                    const frame = extractVideoFrame(tempPath);
                    const label = frame ? await guessContentLabel(frame, "image/jpeg") : "TRAINING VIDEO";
                    const baseName = `${user.first} ${user.last} ${label}`.toUpperCase();
                    const result = await uploadStreamToDrive(createReadStream(tempPath), {
                      name: baseName + ext,
                      mimeType: info.mimeType,
                      folderId: cfg.chatVideosFolderId,
                      accessToken,
                    });
                    return { type, driveFileId: result.id, mimeType: info.mimeType, name: info.filename, driveFileName: baseName };
                  } catch (e) {
                    stream.resume();
                    return { error: e.message, name: info.filename };
                  } finally {
                    try { unlinkSync(tempPath); } catch {}
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
        } else {
          const body = await readJsonBody(req);
          if (!body.text && !body.gifUrl) return sendJson(res, 400, { error: "text or gifUrl required" });
          const messages = readJson(MESSAGES_FILE, []);
          const msg = {
            id: randomUUID(), conversationId: convoId, senderId: user.id,
            type: body.gifUrl ? "gif" : "text",
            text: body.gifUrl || body.text,
            createdAt: new Date().toISOString(),
          };
          messages.push(msg);
          writeJson(MESSAGES_FILE, messages);
          created.push(msg);
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
          recipients = convo.participantIds.map(id => users.find(u => u.id === id)).filter(u => u && u.role === "student");
          if (!recipients.length) return sendJson(res, 400, { error: "This group has no students to schedule with yet" });
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
        const durationMinutes = reqDuration || apptCfg.defaultDurationMinutes || 15;
        const start = new Date(startISO);
        const end = new Date(start.getTime() + durationMinutes * 60000);
        const msgId = randomUUID();
        const coachName = coaches.map(c => `${c.first} ${c.last}`).join(" & ");
        const recipientNames = recipients.map(r => `${r.first} ${r.last}`).join(", ");
        const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: apptCfg.timezone });
        const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: apptCfg.timezone });

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
              timezone: apptCfg.timezone, calendarId: coach.calendarEmail || coach.email,
            });
            googleEventIds.push(ev.id); googleEventLinks.push(ev.htmlLink);
            calendarResults.push({ ok: true });
          } catch (e) { calendarResults.push({ ok: false, error: e.message }); }
        }
        status.calendar = calendarResults.length === 1 ? calendarResults[0]
          : calendarResults.every(r => r.ok) ? { ok: true }
          : { ok: false, error: `${calendarResults.filter(r => !r.ok).length}/${calendarResults.length} failed` };

        // Email/SMS/calendar-description all address each recipient by their
        // own name — sent per-recipient rather than one shared message.
        const evSummary = `Training session — ${coachName} & ${recipientNames}`;
        const evDescription = "Scheduled from PRA Chat.";
        const emailResults = [], smsResults = [];
        for (const client of recipients) {
          const vars = { coachName, firstName: client.first, lastName: client.last, date: dateStr, time: timeStr, duration: durationMinutes };
          if (apptCfg.emailEnabled) {
            try {
              const calButtons = addToCalendarButtonsHtml({ summary: evSummary, description: evDescription, start, end, timezone: apptCfg.timezone, uid: msgId });
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
          startISO, durationMinutes, timezone: apptCfg.timezone,
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
          clientIds: recipients.map(r => r.id), startISO, durationMinutes,
          googleEventId: googleEventIds[0] || null, googleEventIds, status, createdAt: msg.createdAt,
        });
        writeJson("chat_appointments.json", appointments);

        notifyParticipants(convoId, user.id, { title: coachName, body: `📅 Session scheduled: ${dateStr} at ${timeStr}`, conversationId: convoId }).catch(() => {});

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
        if (!isStaff(user)) return sendJson(res, 403, { error: "Staff only" });
        const messageId = msgMatch[1];
        const messages = readJson(MESSAGES_FILE, []);
        const msgIdx = messages.findIndex(m => m.id === messageId && m.conversationId === convoId);
        if (msgIdx < 0) return sendJson(res, 404, { error: "Message not found" });
        if (req.method === "DELETE") {
          const deleted = messages[msgIdx];
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
            eventIds.forEach((eventId, i) => {
              const evCoach = coaches[i] || coach;
              deleteCalendarEvent({ eventId, calendarId: evCoach?.calendarEmail || evCoach?.email })
                .catch(e => console.error("[appt cancel] calendar delete failed", e.message));
            });

            // Best-effort SMS notice, same channel bookings already use --
            // the calendar cancellation above already emails clients on its
            // own via sendUpdates=all.
            if (appt) {
              const cfg = getConfig();
              const apptCfg = cfg.appointments;
              const start = new Date(appt.startISO);
              const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: apptCfg.timezone });
              const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: apptCfg.timezone });
              const coachName = coaches.length ? coaches.map(c => `${c.first} ${c.last}`).join(" & ") : "your coach";
              if (apptCfg.smsEnabled) {
                (appt.clientIds || []).forEach(clientId => {
                  const client = users.find(u => u.id === clientId);
                  if (!client) return;
                  sendApptSms(client.email, client.phone, `Hi ${client.first}, your session with ${coachName} on ${dateStr} at ${timeStr} has been cancelled.`)
                    .catch(e => console.error("[appt cancel] SMS failed", e.message));
                });
              }
            }
          }

          return sendJson(res, 200, { ok: true });
        }
        // PATCH — edit text
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
