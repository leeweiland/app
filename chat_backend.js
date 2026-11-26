// chat_backend.js — WhatsApp-style chat: auth, users, conversations, messages,
// Drive-backed media (upload + streaming proxy), push notifications.
// Mounted from server.js: handleChatRequest(req, res, url) returns true if it
// handled the request, false to let server.js's existing routing continue.

import { readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, unlinkSync, mkdirSync, statSync, renameSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import { request as httpsRequest } from "https";
import { execFileSync, execFile } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
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
import { logActivity } from "./activity_log_backend.js";
import * as MessagesDB from "./chat_messages_sqlite.js";
import { searchYouTube, matchesQuery } from "./content_library.js";
import { transcribeRequestAudio } from "./transcribe.js";
import { buildFromCustomPage } from "./protocol_import.js";
import { analyzeTextWithOpenAI } from "./openai_vision_backend.js";
import { renderCertificate, renderDiscountCard, levelLabel } from "./certificate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USERS_FILE = "chat_users.json";
const SESSIONS_FILE = "chat_sessions.json";
const CONVOS_FILE = "chat_conversations.json";
// Messages moved to SQLite (see chat_messages_sqlite.js / MessagesDB) --
// chat_messages.json is left on disk as an inert, point-in-time backup;
// nothing in this file reads or writes it anymore.
const PUSH_FILE = "chat_push_subscriptions.json";
const CONFIG_FILE = "chat_admin_config.json";

// ── Quick Start (gamified walkthrough, tutorial.js) ─────────────────────
// Settings live in Admin Panel > Quick Start. Per-person timing decides when
// the Quick Start button shows (after they've completed it): the first N days
// of using the app, and again for M days whenever they come back after K+
// days away.
const QS_FILE = "chat_quickstart.json";
// Every Online/Gym buyer on record, built from CRM + sheets + GoTeamUp emails
// (Students panel "All"). Not login accounts -- see buildStudentsOverview.
const HISTORY_STUDENTS_FILE = "chat_history_students.json";
const QS_DAY = 24 * 60 * 60 * 1000;
const QS_DEFAULTS = {
  enabledFor: "testers",          // "off" | "testers" | "everyone"
  testers: ["76f3579b-ed30-46dd-928f-42a32d269dd2"],
  roles: ["user", "trainee", "online", "gym"], // who "everyone" means
  autoStart: true,                // opens by itself on chat until finished or closed
  forceStartDays: 1,              // first N days: opens on EVERY app open until finished (even after X)
  buttonFirstDays: 3,
  awayDays: 3,
  comebackDays: 2,
  testersAlwaysButton: true,      // testers can replay any time
  hidePromoUntilDone: true,       // no Black Friday pointer until Quick Start is finished
  texts: {},                      // "step.sub" -> { title, text } overrides (old, before steps)
  steps: null,                    // Admin Panel step editor: [[{ area, title, text, ...options }]]; null = tutorial.js defaults
  finishMessage: { text: "", senderId: "" }, // posted in their group the first time they finish
};
// Cleans the step editor's save: known option keys only, short strings.
const QS_BOOL_OPTS = ["gymOnly", "onlineOnly", "traineeOnly", "phoneOnly", "desktopOnly", "mustTap"];
function qsCleanSteps(steps) {
  if (!Array.isArray(steps)) return null;
  const out = steps.slice(0, 20).map(st => (Array.isArray(st) ? st : []).slice(0, 15).map(p => {
    if (!p || !/^[a-z_]{2,40}$/.test(String(p.area || ""))) return null;
    const c = { area: String(p.area), title: String(p.title || "").slice(0, 80), text: String(p.text || "").slice(0, 300) };
    for (const k of QS_BOOL_OPTS) if (p[k]) c[k] = true;
    if (p.header) c.header = String(p.header).slice(0, 120);
    if (p.traineeText) c.traineeText = String(p.traineeText).slice(0, 300);
    return c;
  }).filter(Boolean)).filter(st => st.length);
  return out.length ? out : null;
}
function qsRead() {
  const d = readJson(QS_FILE, {});
  return { config: { ...QS_DEFAULTS, ...(d.config || {}) }, users: d.users || {} };
}
function qsEligible(cfg, user) {
  if (!user || cfg.enabledFor === "off") return false;
  if ((cfg.testers || []).includes(user.id)) return true;
  return cfg.enabledFor === "everyone" && (cfg.roles || []).includes(user.role);
}
const RESETS_FILE = "chat_password_resets.json";
const UPLOAD_COUNTERS_FILE = "chat_upload_counters.json";
const TRAINING_PROTOCOLS_FILE = "chat_training_protocols.json";
// Opaque sentinel key the Flow Builder's shared draft is stored under in
// TRAINING_PROTOCOLS_FILE (training-protocol.html's BUILDER_PROTOCOL_ID) --
// never a real user id, never validated against USERS_FILE, just a second
// constant string so both sides of "the builder draft" agree on it.
const BUILDER_PROTOCOL_ID = "__builder__";
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
// Finer-grained than the whole-date list above: { "YYYY-MM-DD": ["1615", ...] }
// blocks just those time slots on that date, leaving the others bookable.
const GYM_BLOCKED_SLOTS_FILE = "chat_gym_blocked_slots.json";
// Public (signed-out) bookings from /chat-app/gym-booking.html -- kept apart
// from chat_appointments.json since these people aren't chat users, so the
// reminder poller (which resolves clientIds to user records) never sees them.
const GYM_BOOKINGS_FILE = "chat_gym_bookings.json";
const GYM_SLOTS = { "1615": "16:15", "1815": "18:15" };
const CALLS_FILE = "chat_calls.json";

const APP_SHEET_ID = "1SQPcRayDql4Fe4BJ5kcHUczMzJGCocy6jAblt3hPplI";
const APP_SHEET_TAB = "APP";

// Gym + Online skill-level tracking — same six categories in both tabs
// (FOUNDATION is pass/fail, the rest are numeric levels), tracked in two
// separate tabs of one spreadsheet since gym and online are run as
// separate rosters. Combined client-side into one searchable list.
const LEVELS_SHEET_ID = "1N3HCeHkt6ELLonZ2u2RbV-8x43UM9VWvGaNVNvGZIA0";
// The spreadsheets are settings now (Admin Panel > User Management); these
// constants are only the defaults.
function extractSheetId(v) {
  const t = String(v || "").trim();
  const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (/^[a-zA-Z0-9_-]{20,}$/.test(t) ? t : "");
}
function appSheetId() { return extractSheetId(getConfig().appSheetId) || APP_SHEET_ID; }
function appSheetTab() { return String(getConfig().appSheetTab || "").trim() || APP_SHEET_TAB; }
function levelsSheetId() { return extractSheetId(getConfig().levelsSheetId) || LEVELS_SHEET_ID; }
function crosscheckTabs() {
  const c = getConfig();
  return {
    online: String(c.crosscheckOnlineTab || "").trim() || "ONLINE BUYERS",
    gym: String(c.crosscheckGymTab || "").trim() || "GYM BUYERS",
    blacklist: String(c.crosscheckBlacklistTab || "").trim() || "BLACKLIST ONLINE & GYM",
  };
}
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

// Instructions given to the AI when a coach generates a training plan
// (training protocol page). Admin-editable in that page's Settings; real
// example plans are always appended after it as "EXAMPLE FORMAT".
const DEFAULT_PROTOCOL_AI_PROMPT = [
  "You are a bodyweight-strength/mobility training coach's assistant, drafting a client's training protocol inside their coaching app.",
  '',
  'Models:',
  '- Study the built protocols given below as EXAMPLE FORMAT. They are real plans our coaches made.',
  '- Use them as your models for structure, wording, volume and the kinds of moves chosen.',
  '',
  'Format:',
  '- Match their plain-language style: rounds/sets/reps written in prose.',
  '- Mix named movements with short structural notes, the way the examples do.',
  "- Don't invent a different format: no markdown tables, no JSON-looking structure in any text field.",
  '',
  'Moves:',
  "- Prefer naming specific movements as 'exercise' items over folding them into a 'note'. The app attaches a real video clip to every named movement, which is the whole point.",
  '- Never repeat a move or a video anywhere in the plan. Every exercise must be a different movement from every other one, across all days.',
].join("\n");

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

// Posted into a brand-new student group the moment it's created (see
// syncDefaultGroups' ensurePersonalGroup) and, as a one-time catch-up, into
// any already-existing group that has no messages at all yet (see
// /api/admin/backfill-welcome-message) — admin-editable text and on/off
// toggle live in chat_admin_config.json. {{firstName}}/{{lastName}} are the
// only tokens that make sense here (same fillTemplate() the appointment
// reminders use), unlike coachName/date/time/duration which don't apply to
// a group that was just created.
const DEFAULT_RENEWAL_MESSAGE = "Hey {{firstName}}! Your training with us wraps up on {{endDate}}. Want to keep the momentum going? Reply here and we'll get your renewal set up.";
const DEFAULT_TRAINEE_WELCOME = "Hey {{firstName}}, welcome to the Powerbatics Handstand Protocol! This is your private chat with me and Alexis. Start with the Day 1 test, write your numbers down, and send us a video any time you want feedback.";
const DEFAULT_WELCOME_MESSAGE = `Welcome to training!  This app is your portal to Body Mastery and gaining Strength, Skill, and Sustainability!

In here, you'll have access to:

1. Your Custom Training Protocol, broken down into Weekly, Daily, or Full Flow (a coach will build this for you, stay tuned)
2. Chat with your Coaching Team and send videos of your moves
3. Levels where you can see your current Level and all the Students
4. A Powerbatics Physique Builder, a tool where you can easily track other aspects of your training
5. The Strength Ninjas World Map to see where everyone is at in the world
6. The Personality Training Profile where you can see what personality type you have and what everyone else has


And a lot more to stay connected, having fun, and making progress!

Something fun to do RIGHT NOW...take the Training Personality Test (it's the 3rd icon from the bottom left)

And send me a message back right now to let me know you got this!  Reply "GOT IT!"`;

// System prompt for summarizeCallRecording() below — admin-editable (the
// "prompt setting" in the admin panel), fed the call's transcript as the
// user message. Deliberately asks for bullet points and a word cap so the
// result reads as a quick recap in a chat bubble, not an essay.
const DEFAULT_CALL_SUMMARY_PROMPT = "You are a supportive movement/gymnastics coach's assistant. You'll be given the transcript of a 1-on-1 training call. Write a short, warm, encouraging recap for the client as 3-6 bullet points: what they worked on, any wins or progress worth celebrating, and one or two specific things to keep practicing before next time. Positive and motivating tone only, never critical or clinical. Don't mention that this came from a transcript or recording. Keep the whole thing under 120 words.";

// System prompt for generateDailyCheckin() below — admin-editable, fed the
// student's own last several chat messages (labeled Student:/Coach:) as the
// user message so the check-in reacts to whatever's actually in the
// conversation instead of being generic, and never says anything that
// contradicts or ignores it.
const DEFAULT_DAILY_CHECKIN_PROMPT = "You are a supportive movement/strength coach's assistant sending a brief daily check-in to a student inside their training chat. You'll be given the last several messages between the student and their coach, oldest first, for context. Write a short, warm, light check-in -- 1 to 3 sentences. Either give genuine encouragement tied to something specific they actually said or did recently, or ask a simple, relevant question about how their training is going. Never reference anything that isn't actually in the conversation, and never say anything confusing, generic-sounding, or out of context -- if there isn't much recent context, keep it simple and general rather than guessing or making something up. Don't mention that this is automated or that you're an AI. Friendly, casual, coach-to-athlete tone, not clinical.";
// "09:00" local time in dailyCheckinTimezone -- same default zone as the
// Gym schedule's own GYM_TZ/DEFAULT_APPOINTMENTS_CONFIG.timezone, since
// that's where this business is actually based.
const DEFAULT_DAILY_CHECKIN_TIME = "09:00";
// Rule the AI applies before writing a check-in (admin-editable): it reads
// the recent conversation and answers SKIP instead of a message when a
// check-in would land in the middle of an active or unresolved exchange.
const DEFAULT_DAILY_CHECKIN_RULE = "Look at the most recent exchange. Skip this student today ONLY if one of these is true: (1) the student asked a question that no coach has answered yet; (2) the student sent a video or photo and no coach has replied after it; (3) a coach asked the student something and the student hasn't answered yet. If none of those is true, send the check-in. A conversation that ended with a coach's reply, or with a simple thanks or got it from the student, is wrapped up, so send.";
const DEFAULT_DAILY_CHECKIN_TIMEZONE = "America/Anchorage";

// Whether someone's moves history shows on their profile: their own choice
// (the toggle on their profile sets showMoves) wins; anyone who never chose
// follows the admin setting movesPublicDefault (Admin panel, on by default).
function movesVisible(u, cfg = getConfig()) {
  return typeof u?.showMoves === "boolean" ? u.showMoves : cfg.movesPublicDefault !== false;
}

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
    // Gym Capture (the coach/admin header camera icon) -- Channel/Group Id
    // is a chat_conversations.json id (picked from a dropdown in the admin
    // panel, not pasted like a Drive folder id) that a captured clip's
    // message gets posted into; Folder Id is where the clip itself is
    // saved in Drive, labeled with whatever the coach typed.
    gymTrainingChannelId: "", gymTrainingFolderId: "1sxSvzkKarlK3QxrnGQufKwKrJ7yd1800",
    gymLevelTestChannelId: "", gymLevelTestFolderId: "1jjtWE3ATlKwJ76qe6JbTWBX4s4O6w7_t",
    // Online Level Test forward (message action bar, coach/admin only) --
    // a coach forwards an already-sent video (plus an optional note) into
    // this channel, no fresh upload/Drive folder involved.
    onlineLevelTestChannelId: "",
    // Physique Builder's favorites highlight-reel montage -- where the
    // generated video gets saved. Separate from favoritesFolderId since a
    // montage is a derived artifact (built from favorites, not itself a
    // favorite), worth being able to route somewhere else in Drive.
    physiqueMontageFolderId: "",
    gifApiKey: "", vapidPublicKey: "", vapidPrivateKey: "",
    welcomeMessageEnabled: true,
    welcomeMessageText: DEFAULT_WELCOME_MESSAGE,
    callSummaryEnabled: true,
    callSummaryPrompt: DEFAULT_CALL_SUMMARY_PROMPT,
    dailyCheckinEnabled: true,
    dailyCheckinPrompt: DEFAULT_DAILY_CHECKIN_PROMPT,
    dailyCheckinTime: DEFAULT_DAILY_CHECKIN_TIME,
    dailyCheckinTimezone: DEFAULT_DAILY_CHECKIN_TIMEZONE,
    dailyCheckinFrequencyValue: 1,
    dailyCheckinFrequencyUnit: "days",
    dailyCheckinSenderId: "",
    dailyCheckinQuietValue: 2,
    dailyCheckinQuietUnit: "days",
    dailyCheckinRule: DEFAULT_DAILY_CHECKIN_RULE,
    defaultProtocolEnabled: false,
    appointments: { ...DEFAULT_APPOINTMENTS_CONFIG },
  });
  ["profilePhotosFolderId", "chatImagesFolderId", "chatVideosFolderId", "trainingProtocolFolderId", "trainingProtocolVideoLibraryFolderId", "powerbaticsVideosFolderId", "favoritesFolderId", "intakeFormsFolderId", "clientNotesFolderId", "callRecordingsFolderId", "bodyScanPhotosFolderId", "nutritionPhotosFolderId", "gymTrainingFolderId", "gymLevelTestFolderId", "physiqueMontageFolderId"].forEach(k => {
    if (cfg[k]) cfg[k] = extractDriveFolderId(cfg[k]);
  });
  if (!cfg.trainingProtocolVideoLibraryFolderId) cfg.trainingProtocolVideoLibraryFolderId = "15dt68-wgb_BVoUw0dmlimBQFcwVf6KTX";
  if (!cfg.powerbaticsVideosFolderId) cfg.powerbaticsVideosFolderId = "1Es9fbvFRx7EuFiZu9t-X8pmZXGigf_wX";
  if (!cfg.intakeFormsFolderId) cfg.intakeFormsFolderId = "1He6NLZU0g9YNiG87C8Vhn2AKfrT6Cz-j";
  if (!cfg.clientNotesFolderId) cfg.clientNotesFolderId = "1fOczxxstyKr9oaBnDvo4cDRhpgl_CWxG";
  if (!cfg.bodyScanPhotosFolderId) cfg.bodyScanPhotosFolderId = "1Da9BVFV5N8vRAEJiPHOSyabGkNPnUhqw";
  if (!cfg.gymTrainingFolderId) cfg.gymTrainingFolderId = "1sxSvzkKarlK3QxrnGQufKwKrJ7yd1800";
  if (!cfg.gymLevelTestFolderId) cfg.gymLevelTestFolderId = "1jjtWE3ATlKwJ76qe6JbTWBX4s4O6w7_t";
  // No non-empty default to fall back to (unlike the ones above) — just
  // ensures the key exists on configs saved before this feature existed, so
  // it isn't silently `undefined` and shows up as an empty field in the
  // admin panel rather than never appearing in the response at all.
  if (cfg.favoritesFolderId === undefined) cfg.favoritesFolderId = "";
  if (cfg.callRecordingsFolderId === undefined) cfg.callRecordingsFolderId = "";
  if (cfg.nutritionPhotosFolderId === undefined) cfg.nutritionPhotosFolderId = "";
  if (cfg.welcomeMessageEnabled === undefined) cfg.welcomeMessageEnabled = true;
  // Trainees (Handstand Protocol buyers), Lee 2026-11-17: off by default.
  if (cfg.traineeWelcomeEnabled === undefined) cfg.traineeWelcomeEnabled = false;
  if (!cfg.traineeWelcomeText) cfg.traineeWelcomeText = DEFAULT_TRAINEE_WELCOME;
  if (!cfg.traineeWelcomeByProduct || typeof cfg.traineeWelcomeByProduct !== "object") cfg.traineeWelcomeByProduct = {};
  if (cfg.traineeWelcomeByProduct.hc21 === undefined) cfg.traineeWelcomeByProduct.hc21 = cfg.traineeWelcomeText;
  if (cfg.traineeWelcomeByProduct.bsp21 === undefined) cfg.traineeWelcomeByProduct.bsp21 = "Hey {{firstName}}, welcome to the Bodyweight Strength Protocol! This is your private chat with me and Alexis. Start with Day 1, and send us a video any time you want feedback.";
  if (cfg.traineeRefundMakeUser === undefined) cfg.traineeRefundMakeUser = true;
  if (!cfg.productPrograms || typeof cfg.productPrograms !== "object") cfg.productPrograms = {};
  if (!cfg.welcomeMessageText) cfg.welcomeMessageText = DEFAULT_WELCOME_MESSAGE;
  if (cfg.callSummaryEnabled === undefined) cfg.callSummaryEnabled = true;
  if (cfg.callSummaryMinMinutes === undefined) cfg.callSummaryMinMinutes = 2;
  if (!cfg.callSummaryPrompt) cfg.callSummaryPrompt = DEFAULT_CALL_SUMMARY_PROMPT;
  if (cfg.dailyCheckinEnabled === undefined) cfg.dailyCheckinEnabled = true;
  if (!cfg.dailyCheckinPrompt) cfg.dailyCheckinPrompt = DEFAULT_DAILY_CHECKIN_PROMPT;
  if (!cfg.dailyCheckinTime) cfg.dailyCheckinTime = DEFAULT_DAILY_CHECKIN_TIME;
  if (!cfg.dailyCheckinTimezone) cfg.dailyCheckinTimezone = DEFAULT_DAILY_CHECKIN_TIMEZONE;
  if (!cfg.dailyCheckinFrequencyValue) cfg.dailyCheckinFrequencyValue = 1;
  if (!cfg.dailyCheckinFrequencyUnit) cfg.dailyCheckinFrequencyUnit = "days";
  if (cfg.dailyCheckinQuietValue === undefined) cfg.dailyCheckinQuietValue = 2;
  if (!cfg.dailyCheckinQuietUnit) cfg.dailyCheckinQuietUnit = "days";
  if (cfg.dailyCheckinRule === undefined) cfg.dailyCheckinRule = DEFAULT_DAILY_CHECKIN_RULE;
  if (cfg.gymTrainingChannelId === undefined) cfg.gymTrainingChannelId = "";
  if (cfg.gymLevelTestChannelId === undefined) cfg.gymLevelTestChannelId = "";
  if (cfg.onlineLevelTestChannelId === undefined) cfg.onlineLevelTestChannelId = "";
  if (cfg.defaultProtocolEnabled === undefined) cfg.defaultProtocolEnabled = false;
  if (cfg.movesPublicDefault === undefined) cfg.movesPublicDefault = true;
  // User Management tab (admin panel) -- see USER_MANAGEMENT_KEYS.
  if (cfg.signupEnabled === undefined) cfg.signupEnabled = true;
  if (cfg.studentCrosscheckEnabled === undefined) cfg.studentCrosscheckEnabled = false;
  if (cfg.studentCrosscheckCrm === undefined) cfg.studentCrosscheckCrm = true;
  if (cfg.autoBuildProtocolEnabled === undefined) cfg.autoBuildProtocolEnabled = true;
  if (cfg.levelsRowOnNewStudent === undefined) cfg.levelsRowOnNewStudent = true;
  if (cfg.staffAlertsEnabled === undefined) cfg.staffAlertsEnabled = true;
  if (cfg.renewalMessageEnabled === undefined) cfg.renewalMessageEnabled = false;
  if (!cfg.renewalMessageDaysBefore) cfg.renewalMessageDaysBefore = 14;
  if (!cfg.renewalMessageText) cfg.renewalMessageText = DEFAULT_RENEWAL_MESSAGE;
  if (cfg.renewalMessageSenderId === undefined) cfg.renewalMessageSenderId = "";
  if (!cfg.loginSessionDays) cfg.loginSessionDays = 30;
  if (!cfg.resetLinkMinutes) cfg.resetLinkMinutes = 60;
  if (!cfg.minPasswordLength) cfg.minPasswordLength = 8;
  if (cfg.forgotPasswordEnabled === undefined) cfg.forgotPasswordEnabled = true;
  if (cfg.studentGroupEnabled === undefined) cfg.studentGroupEnabled = true;
  if (cfg.appSheetTypeEnabled === undefined) cfg.appSheetTypeEnabled = true;
  if (cfg.appSheetId === undefined) cfg.appSheetId = "";
  if (cfg.appSheetTab === undefined) cfg.appSheetTab = "";
  if (cfg.levelsSheetId === undefined) cfg.levelsSheetId = "";
  if (cfg.crosscheckOnlineTab === undefined) cfg.crosscheckOnlineTab = "";
  if (cfg.crosscheckGymTab === undefined) cfg.crosscheckGymTab = "";
  if (cfg.crosscheckBlacklistTab === undefined) cfg.crosscheckBlacklistTab = "";
  if (cfg.crmFinishedSync === undefined) cfg.crmFinishedSync = true;
  if (cfg.crmBlacklistArchive === undefined) cfg.crmBlacklistArchive = true;
  if (cfg.renewalPillsStaff === undefined) cfg.renewalPillsStaff = true;
  if (cfg.holdPillsStaff === undefined) cfg.holdPillsStaff = true;
  if (cfg.renewalStudentNotice === undefined) cfg.renewalStudentNotice = false;
  if (!cfg.renewalStudentText) cfg.renewalStudentText = "Your training wraps up on {{endDate}}. Message your coach to keep going.";
  cfg.access = mergeAccessDefaults(cfg.access);
  if (cfg.physiqueMontageFolderId === undefined) cfg.physiqueMontageFolderId = "";
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
  // readState / renewAck / pinned+favorite lists are that user's own
  // bookkeeping (no page reads them off another user) -- and readState alone
  // (a timestamp per conversation they're in) was 2.4MB of the 3MB
  // /api/chat/conversations response every 3s poll repeated for every
  // participant of every chat, which is what made Chat hang on phones
  // (2026-11-24).
  const { passwordHash, passwordSalt, ip, geo, readState, renewAck, pinnedConvoIds, favoriteConvoIds, ...rest } = u;
  // No media (CRM Enroll popup, 2026-11-24): the app is public, so they show
  // as first name + last initial everywhere.
  if (u.noMedia && rest.last) rest.last = String(rest.last).trim().charAt(0).toUpperCase() + ".";
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
  // No expiry: a login lasts until they log out, reset their password or are blacklisted.
  sessions[token] = { userId, expiresAt: null, createdAt: new Date().toISOString() };
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
  if (!session || (session.expiresAt && session.expiresAt < Date.now())) return null;
  const users = readJson(USERS_FILE, []);
  const found = users.find(u => u.id === session.userId) || null;
  // Archiving revokes access immediately, not just future logins — an
  // already-open session for a now-archived user shouldn't keep working.
  if (found?.archived) return null;
  return found;
}
// 400 days is the longest a browser keeps a cookie; /api/auth/me re-sends it
// on every app open, so in practice it never runs out.
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `pra_session=${token}; HttpOnly; Path=/; Max-Age=${400 * 24 * 3600}; SameSite=Lax`);
}
// One-time on boot: every login still alive stops expiring; dead ones are cleared out.
try {
  const sessions = readJson(SESSIONS_FILE, {});
  let changed = false;
  for (const [t, s] of Object.entries(sessions)) {
    if (s.expiresAt == null) continue;
    if (s.expiresAt < Date.now()) delete sessions[t]; else s.expiresAt = null;
    changed = true;
  }
  if (changed) writeJson(SESSIONS_FILE, sessions);
} catch (e) { console.error("[sessions] forever migration", e.message); }

// Physique Builder's coach/admin "view any student" search -- READ-ONLY
// endpoints (Profile/Fuel/Physique/Reports GETs) call this instead of
// getSessionUser() directly, so a staff session viewing someone else's data
// reads THEIR records instead of the logged-in coach's own. Write routes
// deliberately keep calling getSessionUser() as before (never honor
// ?asUserId) -- viewing is supported, writing on someone else's behalf
// isn't, so a coach browsing a student's Physique Builder can never
// accidentally save/log/analyze something into the wrong account.
// Falls back to the actual session user whenever the override isn't
// applicable (no session, no asUserId, self-view, non-staff requester,
// target doesn't exist, or a coach — not admin — targeting another staff
// member) rather than erroring, so every call site can treat this exactly
// like getSessionUser().
export function resolveTargetUser(req, url) {
  const user = getSessionUser(req);
  if (!user) return null;
  const asUserId = url.searchParams.get("asUserId");
  if (!asUserId || asUserId === user.id || !isStaff(user)) return user;
  const target = readJson(USERS_FILE, []).find(u => u.id === asUserId);
  if (!target) return user;
  if (isAdmin(user)) return target;
  if (user.role === "coach" && !isStaff(target)) return target;
  return user;
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
  // Every JSON API response in this file goes through here, including
  // /api/chat/conversations and /api/chat/contacts -- had no Cache-Control
  // of its own at all. The static HTML/JS files already got an explicit
  // no-store fix (see server.js) specifically because WKWebView's own
  // networking layer applies HTTP heuristic caching (RFC 7234) by default
  // when nothing forbids it, unlike how Chrome's fetch() typically treats
  // an API-shaped response -- a real, previously-unexamined gap that would
  // explain stale sidebar data surviving even a full iOS app reinstall
  // (if it's cached somewhere outside the app's own per-install data store)
  // while the exact same request always came back fresh on Android/desktop.
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
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
// Composer Videos tab: Drive video search. Chat uploads and other
// per-student folders are left out -- this is for sending OUR content.
async function searchDriveVideos(q) {
  const cfg = getConfig();
  const skip = new Set([cfg.chatImagesFolderId, cfg.chatVideosFolderId, cfg.callRecordingsFolderId, cfg.profilePhotosFolderId, cfg.intakeFormsFolderId, cfg.clientNotesFolderId].filter(Boolean));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
  const nameQ = words.map(w => `name contains '${w.replace(/\\/g, "").replace(/'/g, "\\'")}'`).join(" and ");
  const query = `mimeType contains 'video/' and trashed = false` + (nameQ ? ` and ${nameQ}` : "");
  const token = await getDriveAccessToken();
  const u = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=80&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,parents,thumbnailLink,videoMediaMetadata(durationMillis))`;
  const r = await fetch(u, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `Drive ${r.status}`);
  const seen = new Set();
  return (d.files || [])
    .filter(f => !(f.parents || []).some(pid => skip.has(pid)))
    .filter(f => { const k = f.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return matchesQuery(f.name, q); })
    .slice(0, 40)
    .map(f => ({ source: "drive", fileId: f.id, title: f.name.replace(/\.[a-z0-9]{2,4}$/i, ""), thumb: f.thumbnailLink || "", durationSec: f.videoMediaMetadata?.durationMillis ? Math.round(Number(f.videoMediaMetadata.durationMillis) / 1000) : null, modifiedTime: f.modifiedTime }));
}

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
// ── Server-side media cache (Lee, 2026-11-26: "scrubbing is so slow") ──
// Every seek used to be its own Range request to Google Drive (~0.5s each).
// The first time a file is requested it's copied whole to local disk in the
// background; after that every range (scrubbing, replays) is served from
// disk in milliseconds. Container temp storage -- a restart just empties it.
const MEDIA_CACHE_DIR = join(tmpdir(), "pra-media-cache");
const MEDIA_CACHE_MAX_FILE = 300 * 1024 * 1024;
const MEDIA_CACHE_MAX_TOTAL = 4 * 1024 * 1024 * 1024;
const mediaCacheInflight = new Set();
try { mkdirSync(MEDIA_CACHE_DIR, { recursive: true }); } catch {}
const mediaCachePath = (id) => join(MEDIA_CACHE_DIR, String(id).replace(/[^\w-]/g, ""));
function readMediaCacheMeta(id) {
  try {
    const meta = JSON.parse(readFileSync(mediaCachePath(id) + ".json", "utf8"));
    if (meta && meta.size && existsSync(mediaCachePath(id))) return meta;
  } catch {}
  return null;
}
function pruneMediaCache() {
  try {
    const files = readdirSync(MEDIA_CACHE_DIR).filter(f => !f.endsWith(".json") && !f.endsWith(".part"))
      .map(f => { const st = statSync(join(MEDIA_CACHE_DIR, f)); return { f, size: st.size, at: st.atimeMs || st.mtimeMs }; })
      .sort((a, b) => a.at - b.at);
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files) {
      if (total <= MEDIA_CACHE_MAX_TOTAL) break;
      try { unlinkSync(join(MEDIA_CACHE_DIR, x.f)); unlinkSync(join(MEDIA_CACHE_DIR, x.f + ".json")); } catch {}
      total -= x.size;
    }
  } catch {}
}
function warmMediaCache(fileId, accessToken) {
  if (mediaCacheInflight.has(fileId) || readMediaCacheMeta(fileId)) return;
  mediaCacheInflight.add(fileId);
  const final = mediaCachePath(fileId), part = final + "." + process.pid + ".part";
  let settled = false;
  const done = (ok, meta) => {
    if (settled) return;
    settled = true;
    mediaCacheInflight.delete(fileId);
    if (ok) {
      try { renameSync(part, final); writeFileSync(final + ".json", JSON.stringify(meta)); pruneMediaCache(); } catch { try { unlinkSync(part); } catch {} }
    } else { try { unlinkSync(part); } catch {} }
  };
  const r = httpsRequest({ hostname: "www.googleapis.com", path: `/drive/v3/files/${fileId}?alt=media`, method: "GET", headers: { Authorization: `Bearer ${accessToken}` } }, (dr) => {
    const len = Number(dr.headers["content-length"]) || 0;
    if (dr.statusCode !== 200 || len > MEDIA_CACHE_MAX_FILE) { dr.resume(); done(false); return; }
    const out = createWriteStream(part);
    let n = 0;
    dr.on("data", (c) => { n += c.length; if (n > MEDIA_CACHE_MAX_FILE) { dr.destroy(); out.destroy(); done(false); } });
    dr.on("error", () => { out.destroy(); done(false); });
    out.on("error", () => { dr.destroy(); done(false); });
    out.on("finish", () => { if (n > MEDIA_CACHE_MAX_FILE || (len && n !== len)) { done(false); return; } done(true, { size: n, mime: dr.headers["content-type"] || "application/octet-stream" }); });
    dr.pipe(out);
  });
  r.on("error", () => done(false));
  r.setTimeout(10 * 60 * 1000, () => r.destroy());
  r.end();
}
function serveCachedMedia(req, res, fileId, meta) {
  const path = mediaCachePath(fileId), size = meta.size;
  const base = { "Content-Type": meta.mime, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable" };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  let start = 0, end = size - 1, status = 200;
  if (m) {
    if (m[1] === "") { start = Math.max(0, size - Number(m[2] || 0)); }
    else { start = Number(m[1]); if (m[2] !== "") end = Math.min(Number(m[2]), size - 1); }
    if (!(start >= 0) || start >= size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return Promise.resolve(); }
    status = 206;
    base["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  base["Content-Length"] = end - start + 1;
  res.writeHead(status, base);
  return new Promise((resolve) => {
    const rs = createReadStream(path, { start, end });
    rs.on("error", () => { try { res.destroy(); } catch {} resolve(); });
    res.on("close", () => { rs.destroy(); resolve(); });
    rs.on("end", resolve);
    rs.pipe(res);
  });
}

export async function streamDriveMedia(req, res, fileId, accessToken) {
  const cached = readMediaCacheMeta(fileId);
  if (cached) return serveCachedMedia(req, res, fileId, cached);
  warmMediaCache(fileId, accessToken);
  await new Promise((resolve) => {
    // Every failure path below calls this instead of reject() -- settling
    // exactly once no matter which of several listeners fires first (a
    // real finish, a timeout, a Google-side error, or the viewer
    // disconnecting), and never rejecting at all. The old reject() design
    // left the caller's own catch block to call res.writeHead(500) --
    // which throws ERR_HTTP_HEADERS_SENT (itself uncaught, since it's not
    // inside another try/catch) whenever the failure happened AFTER
    // headers were already sent, which is the common case for a mid-
    // stream error. Handling the response entirely in here, and checking
    // headersSent first, avoids that.
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
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
      // Google's alt=media responses never actually send an Accept-Ranges
      // header, even though they correctly honor Range requests (verified:
      // a Range: bytes=0-1023 request gets back exactly 1024 bytes with a
      // matching Content-Range, every time) -- the forwarding loop above
      // only ever copies a header Google itself sent, so this always came
      // out missing. Without it, Chrome's <video> element won't commit to
      // treating the resource as seekable/streamable, and gets stuck
      // indefinitely instead of ever loading a frame -- this is what
      // actually made a video "not play" / show a blocked-play icon with
      // no error, not a Drive outage or a timeout (both checked directly
      // against Google and came back fast and correct).
      passHeaders["Accept-Ranges"] = "bytes";
      res.writeHead(driveRes.statusCode, passHeaders);
      // A network hiccup partway through Google's own response -- without
      // this listener, piping into `res` after `driveRes` errors is an
      // unhandled 'error' event, which can crash the whole process, not
      // just this one request.
      driveRes.on("error", (e) => { console.error("[streamDriveMedia] drive response", e.message); try { res.destroy(); } catch {} finish(); });
      driveRes.pipe(res);
      driveRes.on("end", finish);
    });
    // A student scrolling a video out of view (stepVideoLazyObserver pauses
    // it) or just navigating away mid-download destroys their end of the
    // connection -- piping into an already-closed `res` is the single most
    // common way this hit the unhandled-'error' crash risk above, since it
    // happens on completely ordinary scrolling, not just flaky networks.
    //
    // 'close' fires on EVERY response, successful or not -- per Node's own
    // docs it means "the response is completed, OR its underlying
    // connection was terminated prematurely", not just the premature case.
    // The first version of this handler destroyed driveReq unconditionally
    // here, which tore down the upstream Google request out from under
    // its own still-finishing pipe on literally every normal request too
    // (confirmed live: logged "drive response aborted" on every single
    // video load after deploying that version) -- truncating the response
    // Chrome's video element was mid-way through reading, which is what
    // actually left it stuck at readyState 0 forever. Only destroy when
    // the response hadn't actually finished writing yet.
    res.on("error", () => { driveReq.destroy(); finish(); });
    res.on("close", () => { if (!res.writableEnded) driveReq.destroy(); finish(); });
    // A hung/never-responding Drive request previously left this Promise
    // (and the student's <video> element) waiting forever -- looked like
    // "nothing happens" when tapping play, with no error and no timeout to
    // ever resolve it. Bounding it means a slow/flaky connection surfaces
    // as a real, finite playback error instead of an infinite spinner.
    driveReq.setTimeout(25000, () => driveReq.destroy(new Error("Drive media fetch timed out")));
    driveReq.on("error", (e) => {
      console.error("[streamDriveMedia] drive request", e.message);
      if (!res.headersSent) { try { res.writeHead(502); } catch {} }
      try { res.end(); } catch {}
      finish();
    });
    driveReq.end();
  });
}

// Answers a HEAD on the same media proxy with the headers a GET would send
// (Content-Type/Content-Length/Accept-Ranges), no body -- see the route
// above for why this needs to exist at all (iOS's native video pipeline
// probes with HEAD before it'll attempt real playback). Pulled from
// files.get metadata rather than issuing a HEAD at Google's alt=media
// endpoint -- a metadata call is both cheaper and something Drive's API
// actually documents supporting, whereas the media download endpoint's own
// HEAD behavior isn't.
export async function streamDriveMediaHead(res, fileId, accessToken) {
  await new Promise((resolve) => {
    const driveReq = httpsRequest({
      hostname: "www.googleapis.com",
      path: `/drive/v3/files/${fileId}?fields=mimeType,size`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    }, driveRes => {
      let body = "";
      driveRes.on("data", c => body += c);
      driveRes.on("end", () => {
        try {
          const meta = JSON.parse(body);
          if (driveRes.statusCode >= 300 || !meta.mimeType) { res.writeHead(driveRes.statusCode >= 300 ? driveRes.statusCode : 502); res.end(); resolve(); return; }
          res.writeHead(200, {
            "Content-Type": meta.mimeType,
            ...(meta.size ? { "Content-Length": meta.size } : {}),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=31536000, immutable",
          });
          res.end();
        } catch (e) {
          res.writeHead(502); res.end();
        }
        resolve();
      });
    });
    driveReq.on("error", (e) => {
      console.error("[streamDriveMediaHead] drive request", e.message);
      try { res.writeHead(502); res.end(); } catch {}
      resolve();
    });
    driveReq.setTimeout(10000, () => driveReq.destroy(new Error("Drive metadata fetch timed out")));
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
  if (role === "trainee") return "Trainee";
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
  const range = `'${appSheetTab()}'!A:F`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(range)}`,
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
      `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!A${sheetRow}:F${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: rowValues }),
      }
    );
    if (type) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!J${sheetRow}`)}?valueInputOption=USER_ENTERED`,
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
      `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!A1:J1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
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
  if (getConfig().appSheetTypeEnabled === false) return;
  const accessToken = await getGoogleAccessToken();
  const range = `'${appSheetTab()}'!A:F`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && (r[2] || "").toLowerCase() === (targetUser.email || "").toLowerCase());
  const type = roleToSheetType(targetUser.role);

  if (rowIndex > 0) {
    const sheetRow = rowIndex + 1;
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!J${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[type]] }),
      }
    );
  } else {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!A1:J1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
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
  const range = `'${appSheetTab()}'!A:K`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  const rows = getData.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && (r[2] || "").toLowerCase() === (email || "").toLowerCase());

  if (rowIndex > 0) {
    const sheetRow = rowIndex + 1;
    // Write archetype columns G:I (skip J=TYPE), then gender in K separately
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!G${sheetRow}:I${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[mbti || "", standard || "", archetype || ""]] }),
      }
    );
    if (gender) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!K${sheetRow}`)}?valueInputOption=USER_ENTERED`,
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
      `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${appSheetTab()}'!A1:K1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
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
  const range = `'${appSheetTab()}'!A:K`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(range)}`,
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
  card.levels = levelsEntriesForUser(targetUser, levelsPeople);
  const accessToken = await getGoogleAccessToken();
  const range = `'${appSheetTab()}'!A:K`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(range)}`,
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
  const range = `'${appSheetTab()}'!A:K`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(range)}`,
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
// No-media students' rows live on "<PROGRAM> NO MEDIA" tabs (ONLINE NO MEDIA
// already existed; GYM NO MEDIA is created the first time it's needed).
const LEVELS_TABS = [["GYM", "Gym"], ["ONLINE", "Online"], ["GYM NO MEDIA", "Gym"], ["ONLINE NO MEDIA", "Online"]];
const levelsBaseTab = (program) => program === "Online" ? "ONLINE" : "GYM";
async function fetchLevelsTab(tabName, program) {
  const accessToken = await getGoogleAccessToken();
  const range = `'${tabName}'!A1:J`;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(range)}`,
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
    people.push({ first, last: row[lastIdx] || "", program, levels, team, ...(/NO MEDIA/.test(tabName) ? { noMedia: true, tab: tabName } : {}) });
  }
  return people;
}
async function fetchAllLevels() {
  if (levelsCache && Date.now() - levelsCache.at < 10 * 60 * 1000) return levelsCache.people;
  const tabs = await Promise.all(LEVELS_TABS.map(([t, prog]) => fetchLevelsTab(t, prog)));
  const people = tabs.flat();
  levelsCache = { at: Date.now(), people };
  return people;
}
// ── Level-up trigger → CRM "8 CERTIFICATE" flow (Lee, 2026-11-21) ──────────
// When a coach saves levels in the app (/api/chat/levels/update), a level
// that went UP (a higher number, or Foundation newly marked done) becomes a
// level-up event, sent to the CRM, whose flow waits 5 minutes, asks
// /api/bridge/level-check whether the coach kept it (not a slip they put
// back), then gets the certificate from /api/bridge/certificate (posted into
// the student's app group) and texts/emails its link.
const LEVEL_EVENTS_FILE = "chat_level_events.json"; // { snapshot: { "Gym|first|last": {CAT: value} }, events: [...] }
const CERT_DIR = join(DATA_DIR, "certificates");
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || "https://app-production-3c6a1.up.railway.app";
const levelNum = (v) => { const n = parseInt(String(v ?? "").trim(), 10); return Number.isFinite(n) ? n : null; };
const foundationDone = (v) => /^(x|yes|done|complete|completed|✓)$/i.test(String(v ?? "").trim());
function readLevelEvents() {
  const d = readJson(LEVEL_EVENTS_FILE, null) || {};
  return { snapshot: d.snapshot || null, events: Array.isArray(d.events) ? d.events : [] };
}
// What level they're at now in one category (fresh from the sheet).
async function currentLevelFor(ev) {
  const base = levelsBaseTab(ev.program);
  const tab = [...await fetchLevelsTab(base, ev.program), ...await fetchLevelsTab(base + " NO MEDIA", ev.program)];
  const p = tab.find(x => nameKey(x.first, x.last) === nameKey(ev.first, ev.last));
  return p ? (p.levels || {})[ev.category] : undefined;
}
function stillAdvanced(ev, cur) {
  if (ev.category === "FOUNDATION") return foundationDone(cur);
  const n = levelNum(cur);
  return n !== null && n >= Number(ev.to);
}
function appUserForName(first, last) {
  const k = nameKey(first, last);
  return readJson(USERS_FILE, []).find(u => !u.archived && nameKey(u.first, u.last) === k) || null;
}
// The trigger (Lee, 2026-11-24): a coach saving levels in the app IS the
// event -- the row's old values vs what they just saved. No sheet polling:
// the 2-minute watcher it replaces re-fired the same level-ups every tick
// once students sat on two tabs (GYM + GYM NO MEDIA) and spammed their
// groups, texts and email with 300+ certificates. A person + category +
// level is sent at most once, ever (unless the CRM's check found it was put
// back), so no bug can repeat a send.
const levelUpKey = (first, last, cat, to) => `${nameKey(first, last)}|${cat}|${to}`;
async function levelUpsFromSave({ first, last, program, before, after, by }) {
  if (!before) return; // a brand-new row is someone being added, not leveling up
  const d = readLevelEvents();
  const sent = new Set(d.events.filter(e => e.still !== false).map(e => levelUpKey(e.first, e.last, e.category, e.to)));
  const fresh = [];
  for (const cat of LEVELS_CATEGORIES) {
    const a = before[cat], b = after[cat];
    let up = false;
    if (cat === "FOUNDATION") up = !foundationDone(a) && foundationDone(b);
    else { const na = levelNum(a), nb = levelNum(b); up = nb !== null && nb > (na ?? 0) && nb > 0; }
    if (!up) continue;
    const to = cat === "FOUNDATION" ? String(b) : levelNum(b);
    const key = levelUpKey(first, last, cat, to);
    if (sent.has(key)) { console.log(`[level-up] ${first} ${last} ${cat} ${to} already sent -- skipped`); continue; }
    sent.add(key);
    const u = appUserForName(first, last);
    const ev = {
      id: randomUUID(), first, last, program, category: cat,
      from: a ?? "", to, label: levelLabel(cat, levelNum(b)),
      userId: u?.id || null, email: u?.email || "", phone: u?.phone || "",
      savedBy: by || null, detectedAt: new Date().toISOString(), status: "detected",
    };
    d.events.push(ev); fresh.push(ev);
    console.log(`[level-up] ${first} ${last} ${cat} ${a || "-"} -> ${b} (${program}, saved in the app)`);
  }
  if (!fresh.length) return;
  d.events = d.events.slice(-5000);
  writeJson(LEVEL_EVENTS_FILE, d);
  for (const ev of fresh) await sendLevelUpToCrm(ev);
}
async function sendLevelUpToCrm(ev) {
  try {
    const r = await crmFetch("/api/bridge/level-up", { method: "POST", body: JSON.stringify(ev) });
    const out = await r.json().catch(() => ({}));
    markLevelEvent(ev.id, r.ok ? { status: "sent-to-crm", crm: out } : { status: "crm-error", crmError: out.error || r.status });
  } catch (e) { markLevelEvent(ev.id, { status: "crm-error", crmError: e.message }); }
}
function markLevelEvent(id, patch) {
  const d = readLevelEvents();
  const ev = d.events.find(e => e.id === id);
  if (ev) { Object.assign(ev, patch); writeJson(LEVEL_EVENTS_FILE, d); }
  return ev;
}
// Makes the PNG once per event (same file on every retry), and posts it into
// the student's own group with the congrats text.
async function issueCertificate(ev, { postToApp = true, message = "" } = {}) {
  if (!ev.certToken) {
    mkdirSync(CERT_DIR, { recursive: true });
    const token = randomBytes(12).toString("hex");
    // Lee's own Certificate of Advancement template, blanks filled in (JPEG).
    const jpg = renderCertificate({ name: `${ev.first} ${ev.last}`.trim(), category: ev.category, level: ev.to });
    writeFileSync(join(CERT_DIR, token + ".jpg"), jpg);
    ev = markLevelEvent(ev.id, { certToken: token, certExt: "jpg", certIssuedAt: new Date().toISOString() }) || { ...ev, certToken: token, certExt: "jpg" };
  }
  const ext = ev.certExt || "png";
  const url = `${APP_PUBLIC_URL}/cert/${ev.certToken}.${ext}`;
  let posted = !!ev.appPostedAt;
  if (postToApp && !posted && ev.userId) {
    const convo = readJson(CONVOS_FILE, []).find(c => c.autoGroupType === "student" && c.autoGroupUserId === ev.userId);
    if (convo) {
      const users = readJson(USERS_FILE, []);
      const staffIds = users.filter(u => isStaff(u) && !u.archived).map(u => u.id);
      const lee = users.find(u => isAdmin(u) && /^lee$/i.test(u.first || "") && /weiland/i.test(u.last || ""));
      const senderId = (lee && convo.participantIds.includes(lee.id) ? lee.id : null) || convo.participantIds.find(id => staffIds.includes(id));
      if (senderId) {
        const accessToken = await getDriveAccessToken();
        const name = `${ev.first} ${ev.last} CERTIFICATE ${ev.category} ${ev.to}.${ext}`;
        const mime = ext === "jpg" ? "image/jpeg" : "image/png";
        const uploaded = await uploadStreamToDrive(createReadStream(join(CERT_DIR, ev.certToken + "." + ext)), { name, mimeType: mime, folderId: getConfig().profilePhotosFolderId, accessToken });
        const now = Date.now();
        MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "image", driveFileId: uploaded.id, mimeType: mime, name, createdAt: new Date(now).toISOString() });
        if (message) MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "text", text: message, createdAt: new Date(now + 1).toISOString() });
        notifyParticipants(convo.id, senderId, { title: "New message", body: message ? message.slice(0, 120) : "Your certificate", conversationId: convo.id }).catch(() => {});
        markLevelEvent(ev.id, { appPostedAt: new Date().toISOString() });
        posted = true;
      }
    }
  }
  return { url, posted, appUser: !!ev.userId };
}
// Level-up clothing discount card (CRM "Level-Up Discount" step): made once
// per event, posted into their group right under the certificate.
async function issueDiscountCard(ev, { code, percent, storeUrl, postToApp = true, message = "" }) {
  if (!ev.discToken) {
    mkdirSync(CERT_DIR, { recursive: true });
    const token = randomBytes(12).toString("hex");
    writeFileSync(join(CERT_DIR, token + ".jpg"), renderDiscountCard({ first: ev.first, code, percent, storeUrl }));
    ev = markLevelEvent(ev.id, { discToken: token, discCode: code }) || { ...ev, discToken: token };
  }
  const url = `${APP_PUBLIC_URL}/cert/${ev.discToken}.jpg`;
  let posted = !!ev.discPostedAt;
  if (postToApp && !posted && ev.userId) {
    const convo = readJson(CONVOS_FILE, []).find(c => c.autoGroupType === "student" && c.autoGroupUserId === ev.userId);
    if (convo) {
      const users = readJson(USERS_FILE, []);
      const staffIds = users.filter(u => isStaff(u) && !u.archived).map(u => u.id);
      const lee = users.find(u => isAdmin(u) && /^lee$/i.test(u.first || "") && /weiland/i.test(u.last || ""));
      const senderId = (lee && convo.participantIds.includes(lee.id) ? lee.id : null) || convo.participantIds.find(id => staffIds.includes(id));
      if (senderId) {
        const accessToken = await getDriveAccessToken();
        const name = `${ev.first} ${ev.last} LEVEL UP DISCOUNT ${code}.jpg`;
        const uploaded = await uploadStreamToDrive(createReadStream(join(CERT_DIR, ev.discToken + ".jpg")), { name, mimeType: "image/jpeg", folderId: getConfig().profilePhotosFolderId, accessToken });
        const now = Date.now() + 5; // lands just after the certificate
        MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "image", driveFileId: uploaded.id, mimeType: "image/jpeg", name, createdAt: new Date(now).toISOString() });
        if (message) MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "text", text: message, createdAt: new Date(now + 1).toISOString() });
        notifyParticipants(convo.id, senderId, { title: "New message", body: message ? message.slice(0, 120) : "Your level-up reward", conversationId: convo.id }).catch(() => {});
        markLevelEvent(ev.id, { discPostedAt: new Date().toISOString() });
        posted = true;
      }
    }
  }
  return { url, posted, appUser: !!ev.userId };
}

// ── Katas ────────────────────────────────────────────────────────────────
// Kata videos live in Drive under "KATAS BY ELEMENT" (one subfolder per
// element), each copy renamed "LEVEL <n> - <original name>". A student's
// Katas page / profile kata icon shows the kata for each level they're at.
const KATA_ROOT_FOLDER_ID = "1IpdnlRqiAcNAgJ5Vz7zN3zyEHJqsilnZ";
const KATA_CATS = ["FOUNDATION", "HANDSTAND", "NINJA STRENGTH", "CIRQUE", "POWERMOVES", "FREERUN"];
let kataLibraryCache = null; // { at, byKey: { "HANDSTAND|2": [file...] }, ids: Set }
async function fetchKataLibrary(force) {
  if (!force && kataLibraryCache && Date.now() - kataLibraryCache.at < 60 * 1000) return kataLibraryCache;
  const accessToken = await getDriveAccessToken();
  const H = { headers: { Authorization: `Bearer ${accessToken}` } };
  const list = async (q) => {
    const out = []; let pageToken = "";
    do {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime,mimeType)${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`, H);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || "Drive list failed");
      out.push(...(d.files || [])); pageToken = d.nextPageToken || "";
    } while (pageToken);
    return out;
  };
  const folders = await list(`'${KATA_ROOT_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const byKey = {}; const ids = new Set();
  for (const folder of folders) {
    const cat = KATA_CATS.find(c => c === String(folder.name).trim().toUpperCase());
    if (!cat) continue;
    const files = await list(`'${folder.id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`);
    for (const f of files) {
      if (!/^video\//.test(f.mimeType || "") && !/\.(mp4|mov|m4v|webm)$/i.test(f.name)) continue;
      // "LEVEL 3 - name" (how the copies were labeled), else "LEVEL 3"
      // anywhere in the name; anything in FOUNDATION is its one level (0).
      let m = String(f.name).match(/^LEVEL (\d+) - (.*)$/i);
      if (!m) { const n = String(f.name).match(/\b(?:LEVEL|LVL)\s*(\d{1,2})\b/i); m = n ? [null, n[1], f.name] : (cat === "FOUNDATION" ? [null, "0", f.name] : null); }
      if (!m) continue;
      if (cat === "FOUNDATION") m[1] = "0";
      const rest = m[2].toUpperCase();
      // One video represents each level: Lee's own demo first, then a
      // plain "<ELEMENT> KATA LEVEL n" clip with no student name, then newest.
      const score = (/\bLEE\b/.test(rest) ? 4 : 0) + (rest.startsWith(cat.split(" ")[0]) || rest.startsWith("FREE RUN") ? 3 : 0) + (/LEVEL TEST/.test(rest) ? 1 : 0) - (/OUTTAKE/.test(rest) ? 6 : 0);
      const key = `${cat}|${Number(m[1])}`;
      (byKey[key] = byKey[key] || []).push({ id: f.id, name: m[2], modifiedTime: f.modifiedTime, score });
      ids.add(f.id);
    }
  }
  Object.values(byKey).forEach(arr => arr.sort((a, b) => b.score - a.score || String(b.modifiedTime).localeCompare(String(a.modifiedTime))));
  kataLibraryCache = { at: Date.now(), byKey, ids };
  return kataLibraryCache;
}
// The levels a person is currently at, one kata per element: Foundation
// (only until they're on other levels), then each numbered element they've reached (an unrecorded
// element reads as Level 1 once Foundation is done -- same rule as the
// profile chips).
async function katasForPerson(first, last) {
  // Always re-read the folders here so adding/renaming/removing a video in
  // Drive shows up the next time a Katas page or profile opens.
  const [people, lib] = await Promise.all([fetchAllLevels(), fetchKataLibrary(true)]);
  const entries = findLevelsEntries(people, first, last);
  const checked = (v) => ["x", "yes"].includes(String(v || "").trim().toLowerCase());
  const foundationDone = entries.some(e => checked(e.levels?.FOUNDATION));
  const label = (c) => c.toLowerCase().replace(/(^|\s)\S/g, t => t.toUpperCase());
  const pick = (cat, level) => { const v = (lib.byKey[`${cat}|${level}`] || [])[0]; return v ? { driveFileId: v.id, name: v.name } : null; };
  // Foundation only until they're on the other levels (Lee, 2026-11-20):
  // once Foundation is done -- or any element has a recorded level -- it drops off.
  const katas = [];
  for (const cat of KATA_CATS.slice(1)) {
    const level = Math.max(0, ...entries.map(e => Number(e.levels?.[cat]) || 0)) || (foundationDone ? 1 : 0);
    if (!level) continue;
    katas.push({ cat, level, label: `${label(cat)} Level ${level}`, video: pick(cat, level) });
  }
  if (!katas.length) katas.unshift({ cat: "FOUNDATION", level: 0, label: "Foundation", video: pick("FOUNDATION", 0) });
  return { katas, hasLevels: entries.length > 0 };
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
const ONLINE_SHEET_TAB = "ONLINE BUYERS";
const GYM_SHEET_TAB = "GYM BUYERS";
const STUDENT_BLACKLIST_TAB = "BLACKLIST ONLINE & GYM";
function nameKey(first, last) {
  return `${String(first || "").trim().toLowerCase()}|${String(last || "").trim().toLowerCase()}`;
}
// Shared duplicate-account guard for both public signup and the admin
// "create user" panel -- checks email, then phone, then first+last name,
// in that priority order, so the error always points at whichever field
// actually collided first. Phone is compared digits-only so "907-717-5182"
// and "9077175182" are recognized as the same number; an empty phone never
// matches another empty phone (most existing accounts have none).
function findDuplicateUserReason(users, { email, phone, first, last }) {
  const emailNorm = String(email || "").toLowerCase().trim();
  if (emailNorm && users.some(u => u.email.toLowerCase() === emailNorm)) {
    return "An account with that email already exists";
  }
  const phoneDigits = String(phone || "").replace(/\D/g, "");
  if (phoneDigits && users.some(u => String(u.phone || "").replace(/\D/g, "") === phoneDigits)) {
    return "An account with that phone number already exists";
  }
  if (first && last && users.some(u => nameKey(u.first, u.last) === nameKey(first, last))) {
    return `An account for ${first} ${last} already exists`;
  }
  return null;
}
// Migrated Rogue accounts (chat_history_students.json): the record matching
// someone by email, then phone, then first+last name.
function findRogueRecord({ email, phone, first, last }) {
  const people = readJson(HISTORY_STUDENTS_FILE, { people: [] }).people || [];
  const em = String(email || "").trim().toLowerCase(), ph = String(phone || "").replace(/\D/g, "").slice(-10);
  return (em && people.find(p => p.email === em)) || (ph.length === 10 && people.find(p => p.phone === ph))
    || (first && last && people.find(p => p.first && p.last && nameKey(p.first, p.last) === nameKey(first, last))) || null;
}
// Their migrated levels + where they came from ride along on the real account.
function applyRogueRecord(user, rogue) {
  if (!rogue) return;
  user.migratedRogueId = rogue.id;
  if (rogue.levels && Object.keys(rogue.levels).length) user.levelsHistory = rogue.levels;
  if (!user.phone && rogue.phone) user.phone = rogue.phone;
}
let studentEligibilityCache = null; // { at, online: Set<nameKey>, gym: Set<nameKey> } — 10-minute cache, same idea as the levels cache
// Whoever calls in first while the cache is cold (the boot-time pre-warm
// below, plus any request that lands before it resolves -- several
// concurrent tabs each polling contacts included) now shares the SAME
// in-flight fetch instead of each kicking off its own independent
// three-Sheets-tab read. Without this, a cold cache meant every one of
// those callers separately ate the full several-second fetch.
let studentEligibilityInFlight = null;
let sheetBlacklistedNames = new Set(); // last-read Blacklist tab (names), used by syncStudentRoles
async function fetchStudentEligibility() {
  if (studentEligibilityCache && Date.now() - studentEligibilityCache.at < 10 * 60 * 1000) return studentEligibilityCache;
  if (studentEligibilityInFlight) return studentEligibilityInFlight;
  studentEligibilityInFlight = fetchStudentEligibilityUncached().finally(() => { studentEligibilityInFlight = null; });
  return studentEligibilityInFlight;
}
async function fetchStudentEligibilityUncached() {
  const accessToken = await getGoogleAccessToken();
  async function fetchTab(tabName, range) {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${tabName}'!${range}`)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const d = await r.json();
    return (d.values || []).slice(1); // drop header row
  }
  const [blacklistRows, onlineRows, gymRows] = await Promise.all([
    fetchTab(crosscheckTabs().blacklist, "A1:B"),
    fetchTab(crosscheckTabs().online, "A1:G"),
    fetchTab(crosscheckTabs().gym, "A1:G"),
  ]);
  const blacklisted = new Set(blacklistRows.filter(([first, last]) => first || last).map(([first, last]) => nameKey(first, last)));
  sheetBlacklistedNames = blacklisted;
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
  // Column D is "End Date". A student can have several rows (each renewal adds one) --
  // the LATEST end date wins, so renewing clears the renewal alert on its own.
  function toEndDateMap(rows) {
    const ends = new Map();
    rows.forEach(([first, last, , endDate, status]) => {
      if (!first && !last) return;
      const key = nameKey(first, last);
      if (blacklisted.has(key) || String(status || "").toUpperCase().includes("BLACKLIST")) return;
      const ms = parseSheetDateMs(endDate);
      if (ms != null && (!ends.has(key) || ms > ends.get(key))) ends.set(key, ms);
    });
    return ends;
  }
  // Name by email / phone -- for CRM contacts saved without a name (the
  // Students panel). Online tab: F Phone, G Email; Gym tab: F Email, G Phone.
  const namesByEmail = new Map(), namesByPhone = new Map();
  const addNames = (rows, emailIdx, phoneIdx) => rows.forEach(r => {
    const name = `${r[0] || ""} ${r[1] || ""}`.trim();
    if (!name) return;
    const em = String(r[emailIdx] || "").trim().toLowerCase();
    const ph = String(r[phoneIdx] || "").replace(/\D/g, "").slice(-10);
    if (em) namesByEmail.set(em, name);
    if (ph.length === 10) namesByPhone.set(ph, name);
  });
  addNames(onlineRows, 6, 5);
  addNames(gymRows, 5, 6);
  studentEligibilityCache = { at: Date.now(), online: toEligibleSet(onlineRows), gym: toEligibleSet(gymRows), endDates: { online: toEndDateMap(onlineRows), gym: toEndDateMap(gymRows) }, namesByEmail, namesByPhone };
  return studentEligibilityCache;
}
// Pre-warms the above cache at boot (every deploy restarts the process,
// which wipes it) instead of leaving it cold for whichever staff member's
// sidebar load happens to be first to need it -- that first /api/chat/
// contacts call was eating the full three-Sheets-tab fetch (several real
// seconds) on the user-facing request path.
fetchStudentEligibility().catch(() => {});

// Mark Finished / Blacklist from the Students panel also updates the
// person's Status (column E) on the ONLINE BUYERS + GYM BUYERS tabs:
// every row matched by email or phone (name only if neither matches) that
// isn't already that status. Online tab: F Phone, G Email; Gym: F Email, G Phone.
async function setKickoffSheetStatus({ email, phone, first, last }, status) {
  const accessToken = await getGoogleAccessToken();
  const em = String(email || "").trim().toLowerCase();
  const ph = String(phone || "").replace(/\D/g, "").slice(-10);
  const nk = (first || last) ? nameKey(first, last) : null;
  const data = [];
  for (const [tab, emailIdx, phoneIdx] of [[crosscheckTabs().online, 6, 5], [crosscheckTabs().gym, 5, 6]]) {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values/${encodeURIComponent(`'${tab}'!A1:G`)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const rows = ((await r.json()).values || []);
    const hits = (test) => rows.map((row, i) => i > 0 && test(row) ? i : -1).filter(i => i > 0);
    // Families share an email/phone (a parent's), so when the name is known
    // an email/phone hit must also match the name; a nickname mismatch with
    // no name hit at all still falls back to the email/phone rows.
    const contactHits = hits(row => (em && String(row[emailIdx] || "").trim().toLowerCase() === em) || (ph.length === 10 && String(row[phoneIdx] || "").replace(/\D/g, "").slice(-10) === ph));
    const nameHits = nk ? hits(row => nameKey(row[0], row[1]) === nk) : [];
    let idx = nk ? contactHits.filter(i => nameHits.includes(i)) : contactHits;
    if (!idx.length) idx = nameHits.length ? nameHits : contactHits;
    idx.filter(i => String(rows[i][4] || "").trim().toUpperCase() !== status)
      .forEach(i => data.push({ range: `'${tab}'!E${i + 1}`, values: [[status]] }));
  }
  if (!data.length) return 0;
  const w = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${appSheetId()}/values:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  if (!w.ok) throw new Error(`Sheets ${w.status}`);
  studentEligibilityCache = null;
  return data.length;
}

// ── Renewal alerts (2026-09-19) ──────────────────────────────────────────
// Staff (coach/admin) see a student's chat -- and their coaching group -- flagged when
// the student's END DATE is within 2 months (orange) or 1 month (pink). Same rule as
// the CRM Inbox (crm-app/sqlite_inbox.js): the alert runs through 30 days past the end
// date, then drops. Never sent to non-staff.
const RENEW_DAY_MS = 86400000;
function alaskaTodayMs() {
  return Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Anchorage" }).format(new Date()) + "T00:00:00Z");
}
function addMonthsMs(ms, n) {
  const d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.getTime();
}
// The sheet's End Date column is hand- and form-entered over years: 2026-09-11, 9/11/26,
// 9/11/2026, "Sep 11, 2026", "11 Sep 2026", ... Returns UTC-midnight ms, or null.
export function parseSheetDateMs(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  let y, m, d, mt;
  if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(t))) {
    y = +mt[3]; if (y < 100) y += 2000;
    m = +mt[1]; d = +mt[2];
    if (m > 12 && d <= 12) { const x = m; m = d; d = x; } // 25/12/2026 -> day-first
  } else {
    const dt = new Date(t.replace(/(\d)(st|nd|rd|th)\b/gi, "$1") + " 12:00 UTC");
    if (isNaN(dt)) return null;
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  }
  if (y < 2015 || y > 2040) return null;
  const ms = Date.UTC(y, m - 1, d), chk = new Date(ms);
  return chk.getUTCFullYear() === y && chk.getUTCMonth() === m - 1 && chk.getUTCDate() === d ? ms : null;
}
// 0 none, 1 orange (<= 2 months), 2 pink (<= 1 month)
export function renewalLevelFor(endMs, today = alaskaTodayMs()) {
  if (endMs == null) return 0;
  if (endMs < today - 30 * RENEW_DAY_MS || endMs > addMonthsMs(today, 2)) return 0;
  return endMs <= addMonthsMs(today, 1) ? 2 : 1;
}
// The student a conversation is about: the other person in a DM with a student, or
// the owner of an auto "<Name> Group". Anything else (team chats, staff DMs) has none.
function renewalStudentFor(convo, users, viewerId) {
  let student = null;
  if (convo.type === "dm") student = users.find(u => convo.participantIds.includes(u.id) && u.id !== viewerId);
  else if (convo.autoGroupType === "student") student = users.find(u => u.id === convo.autoGroupUserId);
  return student && isClientRole(student.role) ? student : null;
}
// One alert per STUDENT (not per thread): their own row and their coaching group share it,
// and a staff member seeing either one acknowledges both (viewer.renewAck is keyed by student id).
function renewalForConvo(convo, users, viewer, eligibility) {
  if (!eligibility || !isStaff(viewer)) return null;
  const student = renewalStudentFor(convo, users, viewer.id);
  return student ? renewalForStudent(student, viewer, eligibility) : null;
}
function renewalForStudent(student, viewer, eligibility) {
  if (!eligibility || !isStaff(viewer) || !isClientRole(student.role)) return null;
  if (getConfig().renewalPillsStaff === false) return null;
  const key = nameKey(student.first, student.last);
  const primary = student.role === "gym" ? eligibility.endDates.gym : eligibility.endDates.online;
  const other = student.role === "gym" ? eligibility.endDates.online : eligibility.endDates.gym;
  const endMs = primary.get(key) ?? other.get(key);
  const level = renewalLevelFor(endMs);
  if (!level) return null;
  return { level: level === 2 ? "pink" : "orange", levelNum: level, studentId: student.id, endDate: new Date(endMs).toISOString().slice(0, 10), unhandled: ((viewer.renewAck || {})[student.id] || 0) < level };
}
// Auto-promotes any plain "user" whose name is now sheet-eligible to
// "online" or "gym" (gym takes priority if somehow eligible for both) — a
// manual admin override to any other role always takes precedence going
// forward, since this only ever touches accounts still sitting at the plain
// "user" default.
// Second source (switch studentCrosscheckCrm, default on): a CRM contact with
// status ENROLLED and program type Gym/Online, matched by email, phone, then
// first+last name. Runs on sign-up, login (plain Users only) and when the
// admin user list loads. `onlyId` limits it to one account.
async function syncStudentRoles(usersArg, onlyId = null) {
  // Off by default since 2026-11-12 (Lee): coaches set students up by
  // hand. Switchable in Admin Panel > User Management.
  const cfg = getConfig();
  if (!cfg.studentCrosscheckEnabled) return [];
  try {
    const [sheet, crm] = await Promise.all([
      fetchStudentEligibility().catch(e => { console.error("[student role sync] sheets", e.message); return null; }),
      cfg.studentCrosscheckCrm !== false ? crmEnrolledContacts().catch(e => { console.error("[student role sync] CRM", e.message); return null; }) : null,
    ]);
    const blacklisted = sheetBlacklistedNames;
    const crmRole = (u) => {
      if (!crm) return null;
      const em = String(u.email || "").trim().toLowerCase(), ph = last10(u.phone);
      // Name match only when both first and last are filled in (a blank name would match every unnamed contact).
      const key = String(u.first || "").trim() && String(u.last || "").trim() ? nameKey(u.first, u.last) : null;
      // A family/couple enrollment's other students (CRM FAMILY MEMBERS) count
      // by name too, so whoever from the family joins later is set up.
      const hits = crm.filter(c => (em && c.email.trim().toLowerCase() === em) || (ph.length === 10 && last10(c.phone) === ph) || (key && (nameKey(c.first, c.last) === key || c.familyMembers.some(m => nameKey(m.first, m.last) === key))));
      if (hits.some(c => c.programType === "gym")) return "gym";
      if (hits.some(c => c.programType === "online")) return "online";
      return null;
    };
    // Fresh read after the awaits so a write made meanwhile isn't clobbered.
    const users = readJson(USERS_FILE, []);
    const upgraded = [];
    users.forEach(u => {
      if (u.role !== "user" || u.archived || (onlyId && u.id !== onlyId)) return;
      const key = nameKey(u.first, u.last);
      if (blacklisted.has(key)) return;
      const fromCrm = crmRole(u);
      const next = (sheet?.gym.has(key) || fromCrm === "gym") ? "gym" : (sheet?.online.has(key) || fromCrm === "online") ? "online" : null;
      if (!next) return;
      u.role = next;
      upgraded.push(u);
      console.log(`[student role sync] ${u.first} ${u.last} -> ${next} (${sheet?.[next].has(key) ? "sheet" : "CRM ENROLLED"})`);
    });
    if (upgraded.length) {
      writeJson(USERS_FILE, users); syncDefaultGroups();
      upgraded.forEach(u => {
        ensureStudentLevelsRow(u).catch(() => {});
        syncAppSheetRole(u).catch(e => console.error("[APP sheet role sync]", e.message));
      });
      if (Array.isArray(usersArg)) usersArg.forEach(x => { const n = upgraded.find(u => u.id === x.id); if (n) x.role = n.role; });
    }
    return upgraded;
  } catch (e) {
    console.error("[student role sync]", e.message); // best-effort — never blocks the admin panel from loading
    return [];
  }
}
// Sign-up / login: give the check a few seconds so they land already
// upgraded; if it's slower, it still finishes in the background.
async function upgradeOnArrival(userId) {
  const done = await Promise.race([syncStudentRoles(null, userId), new Promise(r => setTimeout(() => r(null), 6000))]);
  return done && done.length ? done[0].role : null;
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
async function updateLevelsRow({ first, last, program, levels, team, noMedia }) {
  const accessToken = await getGoogleAccessToken();
  // A no-media student's row is on the NO MEDIA tab: edit it there; a new
  // row goes there too when they're flagged no media.
  const base = levelsBaseTab(program);
  const nmRows = await fetchLevelsTab(base + " NO MEDIA", program).catch(() => []);
  const onNm = nmRows.some(x => nameKey(x.first, x.last) === nameKey(first, last));
  const flagged = noMedia ?? !!readJson(USERS_FILE, []).find(u => !u.archived && u.noMedia && nameKey(u.first, u.last) === nameKey(first, last));
  const tabName = onNm || (flagged && await ensureLevelsTab(base + " NO MEDIA", base)) ? base + " NO MEDIA" : base;
  const range = `'${tabName}'!A1:J`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  // Neither this read nor the write below used to check its response status
  // — a bad/expired token or any other Google API error just fell through
  // silently (an empty header here sends every column index to -1, which
  // then produces a malformed range for the write and STILL doesn't throw,
  // since that request's status went unchecked too), reporting success to
  // the coach for an edit that was never actually saved. Throwing here
  // means a real failure surfaces as a real error instead.
  if (!getRes.ok) throw new Error(`Could not read the ${tabName} levels sheet: ` + (getData.error?.message || getRes.status));
  const rows = getData.values || [];
  const header = rows[0] || [];
  const firstIdx = header.indexOf("FIRST NAME");
  const lastIdx = header.indexOf("LAST NAME");
  const teamIdx = header.indexOf("Team");
  const catIdx = LEVELS_CATEGORIES.map(c => header.indexOf(c));
  const width = header.length;
  if (firstIdx < 0 || lastIdx < 0) throw new Error(`The ${tabName} levels sheet's header row looks wrong (no FIRST NAME/LAST NAME column) — check it hasn't been edited.`);

  const newRow = new Array(width).fill("");
  newRow[firstIdx] = first;
  newRow[lastIdx] = last;
  LEVELS_CATEGORIES.forEach((cat, ci) => { if (catIdx[ci] >= 0) newRow[catIdx[ci]] = levels[cat] || ""; });
  if (teamIdx >= 0) newRow[teamIdx] = team ? "X" : "";

  const f = first.trim().toLowerCase(), l = last.trim().toLowerCase();
  const rowIndex = rows.findIndex((r, i) =>
    i > 0 && String(r[firstIdx] || "").trim().toLowerCase() === f && String(r[lastIdx] || "").trim().toLowerCase() === l
  );
  // The row as it was before this save -- the level-up trigger compares it
  // with what the coach just saved (null = a new row, which never fires).
  const before = rowIndex > 0 ? Object.fromEntries(LEVELS_CATEGORIES.map((cat, ci) => [cat, catIdx[ci] >= 0 ? (rows[rowIndex][catIdx[ci]] || "") : ""])) : null;
  const colLetter = (idx) => String.fromCharCode(65 + idx);
  let writeRes, writeData;
  if (rowIndex > 0) {
    const sheetRow = rowIndex + 1;
    writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(`'${tabName}'!A${sheetRow}:${colLetter(width - 1)}${sheetRow}`)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [newRow] }) }
    );
  } else {
    writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(`'${tabName}'!A1:${colLetter(width - 1)}1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: [newRow] }) }
    );
  }
  if (!writeRes.ok) {
    writeData = await writeRes.json().catch(() => ({}));
    throw new Error(`Could not save to the ${tabName} levels sheet: ` + (writeData.error?.message || writeRes.status));
  }
  levelsCache = null; // next read should reflect the write immediately
  return { tabName, before };
}

// Creates a "<X> NO MEDIA" tab (same header as its regular tab) when it
// doesn't exist yet. Returns true when the tab is there.
async function ensureLevelsTab(tabName, copyHeaderFrom) {
  const accessToken = await getGoogleAccessToken();
  const H = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const meta = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}?fields=sheets.properties(title,sheetId)`, { headers: H })).json();
  if ((meta.sheets || []).some(x => x.properties.title === tabName)) return true;
  const hdr = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(`'${copyHeaderFrom}'!1:1`)}`, { headers: H })).json();
  const add = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}:batchUpdate`, { method: "POST", headers: H, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }) });
  if (!add.ok) throw new Error(`Could not create the ${tabName} levels tab`);
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(`'${tabName}'!A1`)}?valueInputOption=RAW`, { method: "PUT", headers: H, body: JSON.stringify({ values: [(hdr.values || [[]])[0]] }) });
  return true;
}
// No media on/off: moves the person's Levels row between their program tab
// and its NO MEDIA tab (columns matched by header name; the old row is
// removed so there are no gaps). Returns what happened.
async function moveLevelsRowNoMedia({ first, last, program, noMedia }) {
  const base = levelsBaseTab(program), from = noMedia ? base : base + " NO MEDIA", to = noMedia ? base + " NO MEDIA" : base;
  const accessToken = await getGoogleAccessToken();
  const H = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const id = levelsSheetId();
  const meta = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(title,sheetId)`, { headers: H })).json();
  const src = (meta.sheets || []).find(x => x.properties.title === from);
  if (!src) return "not on " + from;
  const read = async (t) => (await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${t}'!A1:J`)}`, { headers: H })).json()).values || [];
  const rows = await read(from);
  const hdr = rows[0] || [], fi = hdr.indexOf("FIRST NAME"), li = hdr.indexOf("LAST NAME");
  const idx = rows.findIndex((r, i) => i > 0 && nameKey(r[fi], r[li]) === nameKey(first, last));
  if (idx <= 0) return "not on " + from;
  if (noMedia) await ensureLevelsTab(to, base);
  const destHdr = (await read(to))[0] || hdr;
  const out = destHdr.map(h => { const j = hdr.indexOf(h); return j >= 0 ? (rows[idx][j] ?? "") : ""; });
  const ap = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${to}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: "POST", headers: H, body: JSON.stringify({ values: [out] }) });
  if (!ap.ok) throw new Error(`Could not add them to ${to}`);
  const del = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, { method: "POST", headers: H, body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: src.properties.sheetId, dimension: "ROWS", startIndex: idx, endIndex: idx + 1 } } }] }) });
  if (!del.ok) throw new Error(`Added to ${to} but could not remove the ${from} row`);
  levelsCache = null;
  return `moved ${from} -> ${to}`;
}
// CRM No Media flag for people who aren't on the app yet: applied at sign-up.
const NO_MEDIA_FILE = "chat_no_media.json"; // { pending: { "e:email" | "p:phone10": true } }
function applyPendingNoMedia(u) {
  const pend = readJson(NO_MEDIA_FILE, { pending: {} }).pending || {};
  const em = String(u.email || "").trim().toLowerCase(), ph = last10(u.phone);
  if ((em && pend["e:" + em]) || (ph.length === 10 && pend["p:" + ph])) applyNoMedia(u, true);
}
function applyNoMedia(u, on) {
  u.noMedia = !!on;
  if (on) u.showMoves = false; // their video feed off
  else delete u.showMoves;     // back to the app default
}

// ── Access by role (User Management > Access) ───────────────────────────
// What each kind of account can open. Staff (coach/admin) always get
// everything. Defaults match how the app behaved before these switches.
export const ACCESS_FEATURES = [
  { key: "chat", label: "Chat", desc: "Their group chat with the coaches" },
  { key: "protocol", label: "Custom Training Protocol", desc: "Their own protocol (Flow / Page)" },
  { key: "physique", label: "Physique Builder", desc: "Body scans, photos, food log" },
  { key: "katas", label: "Katas", desc: "Katas tab + kata thumbnails on their profile" },
  { key: "videos", label: "Training Videos", desc: "The Powerbatics video library" },
  { key: "levels", label: "Levels", desc: "The Levels board" },
  { key: "map", label: "Strength Ninjas map", desc: "The map of members" },
  { key: "quiz", label: "Personality Quiz", desc: "Training Personality Quiz" },
  { key: "shop", label: "Shop", desc: "The clothing shop" },
  { key: "retreats", label: "Retreats", desc: "Retreats page" },
];
export const ACCESS_ROLES = ["user", "trainee", "online", "gym", "coach"];
const ACCESS_DEFAULTS = {
  user: { chat: true, protocol: false, physique: false, katas: false, videos: true, levels: true, map: true, quiz: true, shop: true, retreats: true },
  trainee: { chat: true, protocol: true, physique: false, katas: false, videos: true, levels: true, map: true, quiz: true, shop: true, retreats: true },
  online: Object.fromEntries(ACCESS_FEATURES.map(f => [f.key, true])),
  gym: Object.fromEntries(ACCESS_FEATURES.map(f => [f.key, true])),
  coach: Object.fromEntries(ACCESS_FEATURES.map(f => [f.key, true])),
};
function mergeAccessDefaults(a) {
  const out = {};
  for (const role of ACCESS_ROLES) {
    out[role] = {};
    for (const f of ACCESS_FEATURES) {
      const v = a?.[role]?.[f.key];
      out[role][f.key] = typeof v === "boolean" ? v : ACCESS_DEFAULTS[role][f.key];
    }
  }
  return out;
}
export function accessFor(user) {
  if (!user) return {};
  // Admins always see everything; coaches follow their own column.
  if (isAdmin(user)) return Object.fromEntries(ACCESS_FEATURES.map(f => [f.key, true]));
  const a = getConfig().access || mergeAccessDefaults(null);
  return { ...(a[user.role] || a.user) };
}
// The student-facing renewal notice (if switched on) for /api/auth/me.
async function myRenewalNotice(user) {
  const cfg = getConfig();
  if (!cfg.renewalStudentNotice || !isClientRole(user.role)) return null;
  try {
    const eligibility = await fetchStudentEligibility();
    const key = nameKey(user.first, user.last);
    const primary = user.role === "gym" ? eligibility.endDates.gym : eligibility.endDates.online;
    const other = user.role === "gym" ? eligibility.endDates.online : eligibility.endDates.gym;
    const endMs = primary.get(key) ?? other.get(key);
    const level = renewalLevelFor(endMs);
    if (!level) return null;
    const endDate = new Date(endMs).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    return { level: level === 2 ? "pink" : "orange", endDate, text: fillTemplate(cfg.renewalStudentText, { firstName: user.first, lastName: user.last, endDate }) };
  } catch { return null; }
}

// ── Staff alerts (the red banner coaches/admins see) ─────────────────────
// Problems an automation hit that a person needs to fix: auto-build found no
// custom page / videos missing, a student's name doesn't match the Levels
// sheet. Stored ones live here; name mismatches are worked out live.
// Training Protocol's Warmup tab (gym students only) -- same id in training-protocol.html.
const GYM_WARMUP_VIDEO_ID = "1yOb4fOHH3zDQgorX6atyCV2iAzzqR2PG";
const STAFF_ALERTS_FILE = "chat_staff_alerts.json"; // { alerts: [...], dismissed: { [id]: { by, at } } }
function readStaffAlerts() {
  const d = readJson(STAFF_ALERTS_FILE, null) || {};
  return { alerts: Array.isArray(d.alerts) ? d.alerts : [], dismissed: d.dismissed || {} };
}
function addStaffAlert(alert) {
  const d = readStaffAlerts();
  d.alerts = d.alerts.filter(a => a.id !== alert.id);
  d.alerts.push({ ...alert, createdAt: new Date().toISOString() });
  delete d.dismissed[alert.id];
  writeJson(STAFF_ALERTS_FILE, d);
}
function clearStaffAlert(id) {
  const d = readStaffAlerts();
  const before = d.alerts.length;
  d.alerts = d.alerts.filter(a => a.id !== id);
  if (d.alerts.length !== before) writeJson(STAFF_ALERTS_FILE, d);
}
// Students with no device that takes notifications: a coach's call (and
// every message) can't ring them. Goes away by itself once they allow it.
function noPushAlerts() {
  const withDevice = new Set(readJson(PUSH_FILE, []).map(s => s.userId));
  const convos = readJson(CONVOS_FILE, []);
  return readJson(USERS_FILE, []).filter(u => isClientRole(u.role) && !u.archived && !withDevice.has(u.id)).map(u => {
    const g = convos.find(c => c.autoGroupType === "student" && c.autoGroupUserId === u.id);
    return {
      id: "np:" + u.id, kind: "no-push", userId: u.id,
      title: `${`${u.first || ""} ${u.last || ""}`.trim() || u.email}: calls won't ring their phone`,
      detail: "Notifications aren't on for them on any phone, so calls and messages never reach them. Ask them to open the PRA app and allow notifications (the app now asks them too).",
      link: g ? "/chat-app/chat.html?convo=" + encodeURIComponent(g.id) : null,
    };
  });
}
const normName = (x) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
async function nameMismatchAlerts() {
  const people = await fetchAllLevels();
  const crm = await crmEnrolledContacts().catch(() => crmEnrolledSnapshot());
  const users = readJson(USERS_FILE, []).filter(u => isClientRole(u.role) && !u.archived);
  const out = [];
  for (const u of users) {
    const f = normName(u.first), l = normName(u.last);
    if (!f || !l) continue;
    if (people.some(p => normName(p.first) === f && normName(p.last) === l && Object.keys(p.levels || {}).length)) continue;
    // A family/couple login whose people all have their own rows is fine.
    const linked = levelsPeopleForUser(u, people, crm);
    if (linked.length > 1 && linked.every(m => findLevelsEntries(people, m.first, m.last).length)) continue;
    if (people.some(p => normName(p.first) === f && normName(p.last) === l)) continue;
    const near = people.filter(p => {
      const pf = normName(p.first), pl = normName(p.last);
      return (pl === l && (pf[0] === f[0] || pf.startsWith(f) || f.startsWith(pf))) || (pf === f && pl[0] === l[0] && pl.length > 1);
    });
    if (!near.length) continue;
    const names = near.map(p => `"${p.first} ${p.last}" (${p.program})`).join(" or ");
    out.push({
      id: "nm:" + u.id, kind: "name-mismatch", userId: u.id,
      title: `${u.first} ${u.last}: name doesn't match the Levels sheet`,
      detail: `The Levels sheet has ${names}. Their levels and katas won't show in the app until the names match.`,
      link: "/chat-app/levels.html",
    });
  }
  return out;
}

// ── Auto-build a new student's protocol from their custom-site page ──────
// Only ever replaces an untouched default/empty protocol (updatedBy unset --
// a coach's edit or apply stamps their user id) -- a protocol a coach has
// worked on is left alone. Anything that needs a human goes to the banner.
function isUntouchedProtocol(p) {
  return !p || !Array.isArray(p.steps) || !p.steps.length || p.updatedBy == null;
}
async function autoBuildProtocolFromCustomPage(person, { force = false } = {}) {
  if (!force && !getConfig().autoBuildProtocolEnabled) return { status: "off" };
  const name = `${String(person.first || "").trim()} ${String(person.last || "").trim()}`.trim();
  const link = "/chat-app/training-protocol.html?userId=" + encodeURIComponent(person.id);
  let built;
  try {
    built = await buildFromCustomPage(person.first, person.last);
  } catch (e) {
    addStaffAlert({ id: "ab:" + person.id, kind: "auto-build", userId: person.id, link,
      title: `${name}: couldn't build their program`,
      detail: `The custom site didn't answer (${e.message}). Their protocol is still the default -- build it by hand.` });
    return { status: "error", error: e.message };
  }
  if (!built.found) {
    // No custom page is normal (most new students don't have one): they keep
    // the default protocol (Simple But Brutal). Logged, never a staff alert (Lee, 2026-11-20).
    console.log(`[auto-build] ${name}: no custom page -- keeping the default protocol`);
    return { status: "no-page" };
  }
  if (!built.steps.length) {
    addStaffAlert({ id: "ab:" + person.id, kind: "auto-build", userId: person.id, link,
      title: `${name}: their custom page has no moves`,
      detail: `Found "${built.pageTitle}" but couldn't read any moves from it. Their protocol is still the default.` });
    return { status: "empty-page" };
  }
  const all = readJson(TRAINING_PROTOCOLS_FILE, {});
  const existing = all[person.id];
  if (!isUntouchedProtocol(existing)) {
    console.log(`[auto-build] ${name}: left alone (protocol already edited by a coach)`);
    return { status: "left-alone" };
  }
  all[person.id] = { ...(existing || {}), steps: built.steps, protocolName: `${name} - Custom Program`, updatedAt: new Date().toISOString(), updatedBy: "auto-build", builtFrom: built.sourceUrl };
  writeJson(TRAINING_PROTOCOLS_FILE, all);
  clearStaffAlert("ab:" + person.id);
  console.log(`[auto-build] ${name}: built ${built.steps.length} steps from ${built.sourceUrl}`);
  if (built.missing.length) {
    const names = [...new Set(built.missing.map(m => m.name || "video " + m.vimeoId))];
    addStaffAlert({ id: "abm:" + person.id, kind: "auto-build", userId: person.id, link,
      title: `${name}: ${names.length} video${names.length === 1 ? "" : "s"} missing from their program`,
      detail: `Built from "${built.pageTitle}", but these aren't in Drive yet so they show as text only: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}.` });
  } else clearStaffAlert("abm:" + person.id);
  return { status: "built", steps: built.steps.length, missing: built.missing.length, page: built.pageTitle };
}

// ── Renewal auto-message ────────────────────────────────────────────────
// Off by default. Once a day (10am-1pm Alaska) every Online/Gym student
// whose end date (kickoff sheet) is within N days gets one message in their
// group -- at most once per end date.
const RENEWAL_SENT_FILE = "chat_renewal_messages_sent.json"; // { [userId]: "YYYY-MM-DD" end date already messaged }
async function checkRenewalMessages() {
  const cfg = getConfig();
  if (!cfg.renewalMessageEnabled || !cfg.renewalMessageText) return;
  const mins = currentMinutesInZone("America/Anchorage");
  if (mins < 10 * 60 || mins > 13 * 60) return;
  const eligibility = await fetchStudentEligibility();
  const users = readJson(USERS_FILE, []);
  const convos = readJson(CONVOS_FILE, []);
  const sent = readJson(RENEWAL_SENT_FILE, null) || {};
  const today = alaskaTodayMs();
  const winDays = Math.max(1, Number(cfg.renewalMessageDaysBefore) || 14);
  let changed = false;
  for (const u of users) {
    if (!isClientRole(u.role) || u.archived) continue;
    const key = nameKey(u.first, u.last);
    const primary = u.role === "gym" ? eligibility.endDates.gym : eligibility.endDates.online;
    const other = u.role === "gym" ? eligibility.endDates.online : eligibility.endDates.gym;
    const endMs = primary.get(key) ?? other.get(key);
    if (endMs == null) continue;
    const daysLeft = Math.round((endMs - today) / RENEW_DAY_MS);
    if (daysLeft < 0 || daysLeft > winDays) continue;
    const endDate = new Date(endMs).toISOString().slice(0, 10);
    if (sent[u.id] === endDate) continue;
    const convo = convos.find(c => c.autoGroupType === "student" && c.autoGroupUserId === u.id);
    if (!convo) continue;
    const senderId = (cfg.renewalMessageSenderId && convo.participantIds.includes(cfg.renewalMessageSenderId))
      ? cfg.renewalMessageSenderId
      : convo.participantIds.find(id => isAdmin(users.find(x => x.id === id) || {})) || convo.participantIds.find(id => id !== u.id);
    if (!senderId) continue;
    const pretty = new Date(endMs).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    const text = fillTemplate(cfg.renewalMessageText, { firstName: u.first, lastName: u.last, endDate: pretty, userId: u.id });
    MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "text", text, createdAt: new Date().toISOString() });
    notifyParticipants(convo.id, senderId, { title: "New message", body: pushText(text).slice(0, 120), conversationId: convo.id }).catch(() => {});
    sent[u.id] = endDate; changed = true;
    console.log(`[renewal message] ${u.first} ${u.last} (ends ${endDate})`);
  }
  if (changed) writeJson(RENEWAL_SENT_FILE, sent);
}
setInterval(() => { checkRenewalMessages().catch(e => console.error("[renewal message]", e.message)); }, 30 * 60 * 1000);

// A new student (online/gym) starts at Foundation: give them a Levels sheet
// row (GYM or ONLINE tab by role, Foundation blank = In Progress) unless
// they're already on either tab. Called wherever someone becomes a student.
async function ensureStudentLevelsRow(u) {
  if (!u || !isClientRole(u.role) || !u.first || !u.last) return;
  if (getConfig().levelsRowOnNewStudent === false) return;
  levelsCache = null;
  const people = await fetchAllLevels();
  if (findLevelsEntries(people, u.first, u.last).length) return;
  await updateLevelsRow({ first: u.first, last: u.last, program: u.role === "gym" ? "Gym" : "Online", levels: {}, team: false });
  console.log("[levels] added Foundation row for new student", u.first, u.last, u.role);
}

// Fixes a name typo/legal-name change right from the Levels tab or a chat
// profile popup. Unlike updateLevelsRow (which overwrites a whole row's
// levels/team from a full payload), this only ever touches the FIRST
// NAME/LAST NAME cells of whichever row matches the OLD name, on either or
// both tabs a person could have a row on, leaving their recorded
// levels/team untouched. Returns which tabs actually had a matching row.
async function renameLevelsRows({ first, last, newFirst, newLast }) {
  const accessToken = await getGoogleAccessToken();
  const f = first.trim().toLowerCase(), l = last.trim().toLowerCase();
  const colLetter = (idx) => String.fromCharCode(65 + idx);
  const updatedTabs = [];
  for (const [tabName] of LEVELS_TABS) {
    const range = `'${tabName}'!A1:J`;
    const getRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const getData = await getRes.json();
    if (!getRes.ok && /NO MEDIA/.test(tabName)) continue;
    if (!getRes.ok) throw new Error(`Could not read the ${tabName} levels sheet: ` + (getData.error?.message || getRes.status));
    const rows = getData.values || [];
    const header = rows[0] || [];
    const firstIdx = header.indexOf("FIRST NAME");
    const lastIdx = header.indexOf("LAST NAME");
    if (firstIdx < 0 || lastIdx < 0) continue;
    const rowIndex = rows.findIndex((r, i) =>
      i > 0 && String(r[firstIdx] || "").trim().toLowerCase() === f && String(r[lastIdx] || "").trim().toLowerCase() === l
    );
    if (rowIndex <= 0) continue; // not on this tab — nothing to rename here
    const sheetRow = rowIndex + 1;
    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values:batchUpdate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          valueInputOption: "USER_ENTERED",
          data: [
            { range: `'${tabName}'!${colLetter(firstIdx)}${sheetRow}`, values: [[newFirst]] },
            { range: `'${tabName}'!${colLetter(lastIdx)}${sheetRow}`, values: [[newLast]] },
          ],
        }),
      }
    );
    if (!writeRes.ok) {
      const writeData = await writeRes.json().catch(() => ({}));
      throw new Error(`Could not rename on the ${tabName} levels sheet: ` + (writeData.error?.message || writeRes.status));
    }
    updatedTabs.push(tabName);
  }
  levelsCache = null; // next read should reflect the rename immediately
  return updatedTabs;
}

// Read-only name lookup against a single Levels tab -- used by the "add new
// student" duplicate check below. Kept separate from updateLevelsRow's own
// read (which needs the full row width to write back) since this is just a
// cheap existence check across both tabs before ever touching the sheet.
async function findLevelsRowByName(tabName, first, last) {
  const accessToken = await getGoogleAccessToken();
  const range = `'${tabName}'!A1:J`;
  const getRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${levelsSheetId()}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const getData = await getRes.json();
  if (!getRes.ok) throw new Error(`Could not read the ${tabName} levels sheet: ` + (getData.error?.message || getRes.status));
  const rows = getData.values || [];
  const header = rows[0] || [];
  const firstIdx = header.indexOf("FIRST NAME");
  const lastIdx = header.indexOf("LAST NAME");
  if (firstIdx < 0 || lastIdx < 0) return false;
  const f = first.trim().toLowerCase(), l = last.trim().toLowerCase();
  return rows.some((r, i) => i > 0 && String(r[firstIdx] || "").trim().toLowerCase() === f && String(r[lastIdx] || "").trim().toLowerCase() === l);
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
// Push notifications show "[words](url)" links as just the words.
const pushText = (t) => String(t || "").replace(/\[([^\]\n]{1,160})\]\((https?:\/\/[^\s)<]+)\)/g, "$1");
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

// ── Gym availability: whole-date blocks + per-slot blocks ──────────────────
// Shared by the in-chat Gym scheduling, the admin editor, and the public
// booking page -- one facility, one set of blocks for all of them.
function getGymAvailability() {
  return { dates: readJson(GYM_BLOCKED_DATES_FILE, []), slots: readJson(GYM_BLOCKED_SLOTS_FILE, {}) };
}
function isGymSlotBlocked(date, slot) {
  const { dates, slots } = getGymAvailability();
  return dates.includes(date) || (slots[date] || []).includes(slot);
}
// Today's calendar date (YYYY-MM-DD) as read in a specific zone.
function todayInZone(timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// ── Public Gym booking (signed-out, from /chat-app/gym-booking.html) ───────
const GYM_TZ = "America/Anchorage";
const GYM_MAX_ADVANCE_DAYS = 120;
const publicBookAttempts = new Map(); // ip -> [timestamps within the last hour]
function publicBookRateLimited(req) {
  // Last X-Forwarded-For entry: the one the platform's own proxy appended,
  // not anything the caller could have put in the header themselves.
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  const ip = xff[xff.length - 1] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (publicBookAttempts.get(ip) || []).filter(t => now - t < 3600000);
  const limited = recent.length >= 10;
  if (!limited) recent.push(now);
  publicBookAttempts.set(ip, recent);
  if (publicBookAttempts.size > 5000) {
    for (const [k, v] of publicBookAttempts) if (!v.some(t => now - t < 3600000)) publicBookAttempts.delete(k);
  }
  return limited;
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Public Levels board (embedded on pacificrimathletics.com/levels) ──────
// Signed-out, read-only: names, program, levels, and a profile photo. Cached
// 10 minutes so website traffic never hits the Levels/APP sheets directly.
// Photos are served only for people on this board, as 160px JPEG thumbnails
// made once with ffmpeg and kept on the volume.
let publicLevelsCache = null;
async function getPublicLevels() {
  if (publicLevelsCache && Date.now() - publicLevelsCache.at < 10 * 60 * 1000) return publicLevelsCache;
  const enriched = await enrichLevelsPeople(await fetchAllLevels());
  // Badges as a signed-out visitor sees them: same rule as a student viewer
  // (canSeeBadges), so coaches/admins and Lee show none. People with no app
  // account get zeros, like in the app.
  const idByName = new Map(readJson(USERS_FILE, []).filter(u => !u.archived).map(u => [nameKey(u.first, u.last), u.id]));
  const ranked = rankBadgesFor({ id: "public", role: "online" }, computeBadges()).users;
  // No-media students never appear on the public website board.
  const noMediaNames = new Set(readJson(USERS_FILE, []).filter(u => u.noMedia).map(u => nameKey(u.first, u.last)));
  const people = enriched.filter(p => !p.noMedia && !noMediaNames.has(nameKey(p.first, p.last))).map(p => {
    const uid = idByName.get(nameKey(p.first, p.last));
    return {
      // Last initial only on the public website.
      first: (p.first || "").trim(), last: (p.last || "").trim().charAt(0).toUpperCase(),
      program: p.program, levels: p.levels || {}, team: !!p.team,
      photo: p.profilePictureFileId || null,
      badges: uid ? (ranked[uid] || null) : {},
    };
  });
  publicLevelsCache = { at: Date.now(), people, photoIds: new Set(people.map(p => p.photo).filter(Boolean)) };
  return publicLevelsCache;
}
const PUBLIC_AVATAR_DIR = join(DATA_DIR, "public_avatar_cache");
async function publicAvatarFile(fileId) {
  const out = join(PUBLIC_AVATAR_DIR, fileId.replace(/[^\w-]/g, "") + ".jpg");
  if (existsSync(out)) return out;
  mkdirSync(PUBLIC_AVATAR_DIR, { recursive: true });
  const accessToken = await getDriveAccessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Drive ${r.status}`);
  const src = join(tmpdir(), `pubav-${randomUUID()}`);
  writeFileSync(src, Buffer.from(await r.arrayBuffer()));
  try {
    await new Promise((resolve, reject) => execFile(FFMPEG_EXE, ["-y", "-i", src, "-vf", "scale=160:160:force_original_aspect_ratio=increase,crop=160:160", "-frames:v", "1", "-q:v", "4", out], { timeout: 30000 }, (e) => e ? reject(e) : resolve()));
  } finally { try { unlinkSync(src); } catch {} }
  return out;
}
async function handlePublicLevelsRequest(req, res, url) {
  const p = url.pathname;
  if (p === "/api/public/levels" && req.method === "GET") {
    try {
      const { people } = await getPublicLevels();
      res.setHeader("Cache-Control", "public, max-age=300");
      sendJson(res, 200, { people, categories: LEVELS_CATEGORIES });
    } catch (e) {
      console.error("[public levels]", e.message);
      sendJson(res, 500, { error: "Could not load levels" });
    }
    return true;
  }
  const photoMatch = p.match(/^\/api\/public\/levels\/photo\/([\w-]+)$/);
  if (photoMatch && req.method === "GET") {
    try {
      const { photoIds } = await getPublicLevels();
      if (!photoIds.has(photoMatch[1])) { res.writeHead(404); res.end(); return true; }
      const file = await publicAvatarFile(photoMatch[1]);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      createReadStream(file).pipe(res);
    } catch (e) {
      console.error("[public levels photo]", e.message);
      res.writeHead(404); res.end();
    }
    return true;
  }
  return false;
}

async function handlePublicGymRequest(req, res, url) {
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/public/gym-availability") {
    const { dates, slots } = getGymAvailability();
    const today = todayInZone(GYM_TZ);
    const futureSlots = Object.fromEntries(Object.entries(slots).filter(([d]) => d >= today));
    return sendJson(res, 200, { dates: dates.filter(d => d >= today), slots: futureSlots, today, maxAdvanceDays: GYM_MAX_ADVANCE_DAYS });
  }

  if (req.method === "POST" && p === "/api/public/gym-book") {
    if (publicBookRateLimited(req)) return sendJson(res, 429, { error: "Too many attempts -- please try again in a bit." });
    const body = await readJsonBody(req);
    // Honeypot: a real visitor never sees or fills this field. Acts like it
    // worked so a bot has nothing to learn from the response.
    if (body.website) return sendJson(res, 200, { ok: true });

    const clean = (s) => String(s || "").replace(/[\r\n"<>]/g, "").replace(/\s+/g, " ").trim();
    const first = clean(body.first), last = clean(body.last);
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const { date, slot } = body;
    if (!first || !last || first.length > 60 || last.length > 60) return sendJson(res, 400, { error: "Please enter your first and last name." });
    if (email.length > 254 || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email)) return sendJson(res, 400, { error: "Please enter a valid email address." });
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length < 7 || phoneDigits.length > 15 || !/^[+\d\s().-]+$/.test(phone)) return sendJson(res, 400, { error: "Please enter a valid phone number." });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: "Please pick a date." });
    if (!GYM_SLOTS[slot]) return sendJson(res, 400, { error: "Please pick a time." });

    const weekday = weekdayInZone(date, GYM_TZ);
    if (weekday === 0 || weekday === 6) return sendJson(res, 400, { error: "Gym sessions are only available Monday through Friday." });
    if (isGymSlotBlocked(date, slot)) return sendJson(res, 400, { error: "That time isn't available -- please pick another." });

    const start = zonedTimeToUtc(date, GYM_SLOTS[slot], GYM_TZ);
    if (isNaN(start.getTime())) return sendJson(res, 400, { error: "Please pick a valid date." });
    if (start.getTime() <= Date.now()) return sendJson(res, 400, { error: "That time has already passed." });
    if (start.getTime() > Date.now() + GYM_MAX_ADVANCE_DAYS * 86400000) return sendJson(res, 400, { error: `Bookings open up to ${GYM_MAX_ADVANCE_DAYS} days ahead.` });

    const bookings = readJson(GYM_BOOKINGS_FILE, []);
    if (bookings.some(b => b.email === email && b.date === date && b.slot === slot)) {
      return sendJson(res, 409, { error: "You're already booked for that session." });
    }
    if (bookings.filter(b => b.email === email && new Date(b.startISO) > new Date()).length >= 5) {
      return sendJson(res, 429, { error: "You already have several upcoming sessions booked -- reach out to the team to change them." });
    }

    const apptCfg = getConfig().appointments;
    if (!apptCfg.gymCalendarId) return sendJson(res, 503, { error: "Online booking isn't available right now -- please reach out to the team." });

    const durationMinutes = 90;
    const end = new Date(start.getTime() + durationMinutes * 60000);
    const bookingId = randomUUID();
    const evSummary = `GYM 90 MINUTE TRAINING BLOCK — ${first} ${last}`;
    const evDescription = `Booked online.\nPhone: ${phone}\nEmail: ${email}`;

    // The calendar event is what the gym team actually works from, so a
    // failure here fails the whole booking (nothing gets recorded that the
    // team can't see) instead of telling the person they're booked.
    let googleEventId = null, googleEventLink = null;
    try {
      const ev = await createCalendarEvent({
        summary: evSummary, description: evDescription, startISO: start.toISOString(), durationMinutes,
        attendees: [{ email, name: `${first} ${last}` }], timezone: GYM_TZ, calendarId: apptCfg.gymCalendarId,
      });
      googleEventId = ev.id; googleEventLink = ev.htmlLink;
    } catch (e) {
      console.error("[public-gym-book] calendar event failed:", e.message);
      return sendJson(res, 502, { error: "We couldn't complete your booking -- please try again, or reach out to the team." });
    }

    const dateStr = start.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: GYM_TZ });
    const timeStr = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: GYM_TZ });
    const coachName = "Pacific Rim Athletics";
    const vars = { coachName, firstName: first, lastName: last, date: dateStr, time: timeStr, duration: durationMinutes };
    const status = { calendar: { ok: true }, email: null, sms: null };

    if (apptCfg.emailEnabled) {
      try {
        const calButtons = addToCalendarButtonsHtml({ summary: evSummary, description: evDescription, start, end, timezone: GYM_TZ, uid: bookingId });
        // Names came from a public form, so they're escaped before landing in
        // the HTML body (the subject/SMS are plain text and don't need it).
        const html = fillTemplate(apptCfg.emailBodyTemplate, { ...vars, firstName: escHtml(first), lastName: escHtml(last) }) + calButtons;
        const ics = buildIcs({ summary: evSummary, description: evDescription, start, end, uid: bookingId });
        await sendEmail(email, `${first} ${last}`, fillTemplate(apptCfg.emailSubjectTemplate, vars), html, [
          { filename: "invite.ics", mimeType: "text/calendar", content: ics },
        ]);
        status.email = { ok: true };
      } catch (e) { status.email = { ok: false, error: e.message }; }
    } else status.email = { ok: false, error: "disabled" };

    if (apptCfg.smsEnabled) {
      try {
        await sendApptSms(email, phone, fillTemplate(apptCfg.smsTemplate, vars));
        status.sms = { ok: true };
      } catch (e) { status.sms = { ok: false, error: e.message }; }
    } else status.sms = { ok: false, error: "disabled" };

    bookings.push({ id: bookingId, first, last, email, phone, date, slot, startISO: start.toISOString(), durationMinutes, googleEventId, googleEventLink, status, createdAt: new Date().toISOString() });
    writeJson(GYM_BOOKINGS_FILE, bookings);

    return sendJson(res, 200, { ok: true, whenLabel: `${dateStr} at ${timeStr}`, status });
  }

  return false;
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
          const reminderMsg = apptCfg.messengerReminderUseDefault
            ? { id: randomUUID(), conversationId: appt.conversationId, senderId: appt.coachId, type: "appointment",
                startISO: appt.startISO, durationMinutes: appt.durationMinutes, timezone: appt.isGym ? "America/Anchorage" : null,
                isGym: !!appt.isGym, clientIds: appt.clientIds || [],
                googleEventId: appt.googleEventId, googleEventLink: MessagesDB.getMessageById(appt.id)?.googleEventLink || null,
                createdAt: new Date().toISOString() }
            : { id: randomUUID(), conversationId: appt.conversationId, senderId: appt.coachId, type: "text",
                text: fillTemplate(apptCfg.messengerReminderTemplate, vars), createdAt: new Date().toISOString() };
          MessagesDB.insertMessage(reminderMsg);
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
    if (isTrainee(user)) continue; // no Physique Builder for trainees
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

// ── Daily coach check-in ──────────────────────────────────────────────────
// Similar polling pattern to checkPhysiqueCheckinReminders above (hourly
// poll, per-user "already sent" marker) but gated on a specific wall-clock
// time of day in an admin-configured IANA zone (dailyCheckinTime/
// dailyCheckinTimezone) instead of a rolling N-hours-since-last-send
// window -- a rolling window can drift to any hour (including the middle
// of the night for the student), which defeats the point of a "daily
// check-in" landing at a predictable time. The per-user marker is now a
// calendar DATE string in that same zone (dailyCheckinSentDate), not a
// timestamp, so "already sent today" means today in the configured zone,
// not "within the last 24 hours" (those differ right around the target
// time on a day the poll ran a little early/late). Posts an actual
// AI-generated chat message into the student's group instead of a push
// reminder -- grounded in their own last several messages (see
// DEFAULT_DAILY_CHECKIN_PROMPT) so it reacts to the real conversation
// instead of being a generic ping. Online/gym clients only (isClientRole) --
// a plain "user" signup has no personal group to post into at all.
//
// currentMinutesInZone/todayInZone reuse the exact same Intl-based
// wall-clock approach as the Gym schedule's own todayInZone/weekdayInZone
// above (DST-correct for the given date, no extra dependency) -- todayInZone
// itself is literally reused as-is, not reimplemented.
function currentMinutesInZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const hour = Number(parts.find(p => p.type === "hour").value) % 24; // en-GB's midnight sometimes formats as "24"
  const minute = Number(parts.find(p => p.type === "minute").value);
  return hour * 60 + minute;
}
// Returns the check-in text, or null when the rule (ruleText) says to skip.
// Videos/photos show up in the transcript as [sent a video] etc. with dates,
// so the rule can see that kind of activity too, not just text.
async function generateDailyCheckin(conversationId, studentId, promptText, ruleText) {
  const MEDIA = { video: "[sent a video]", image: "[sent a photo]", file: "[sent a file]", call: "[video call]" };
  const recent = MessagesDB.getConversationMessages(conversationId, { limit: 15 })
    .filter(m => (m.type === "text" && m.text && m.text.trim()) || MEDIA[m.type]);
  const transcript = recent.length
    ? recent.map(m => `[${(m.createdAt || "").slice(0, 16).replace("T", " ")}] ${m.senderId === studentId ? "Student" : "Coach"}: ${m.type === "text" ? m.text.trim() : MEDIA[m.type]}`).join("\n")
    : "(No recent messages yet -- this student's chat is new or quiet.)";
  const rule = (ruleText || "").trim();
  const system = (promptText || DEFAULT_DAILY_CHECKIN_PROMPT)
    + (rule ? `\n\nBefore writing anything, apply this rule to the conversation:\n${rule}\n\nAnswer as JSON: {"send": true or false, "reason": "one short sentence on why", "message": "the check-in text, or empty when not sending"}.` : "");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Today is ${new Date().toISOString().slice(0, 10)}. Here are the student's last several chat messages, oldest first:\n\n${transcript}` },
      ],
      max_tokens: 300,
      temperature: 0.7,
      ...(rule ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Check-in generation failed");
  const out = (data.choices?.[0]?.message?.content || "").trim();
  if (!rule) return out || null;
  // Asking for a reason alongside the yes/no keeps the model from skipping
  // by default (a bare "reply SKIP" made it skip resolved chats too).
  let verdict;
  try { verdict = JSON.parse(out); } catch { return null; }
  if (!verdict.send) { console.log(`[daily checkin] skipped ${studentId}: ${verdict.reason || ""}`); return null; }
  return String(verdict.message || "").trim() || null;
}
// Whole calendar days between two YYYY-MM-DD strings (both already read in
// the same zone via todayInZone/dailyCheckinSentDate) -- parsed as UTC
// midnight so the subtraction is pure date arithmetic, with no timezone or
// DST involved a second time (that's already baked into which calendar day
// each string names).
function daysBetweenDateStrings(earlier, later) {
  return Math.round((new Date(later + "T00:00:00Z") - new Date(earlier + "T00:00:00Z")) / 86400000);
}
// "Months" has no fixed day count -- 30 is a plain, predictable
// approximation (not calendar-month-aware), good enough for a check-in
// cadence where landing a day or two early/late next to the exact
// anniversary doesn't matter.
function dailyCheckinRequiredDays(cfg) {
  const value = Math.max(1, Number(cfg.dailyCheckinFrequencyValue) || 1);
  const unit = cfg.dailyCheckinFrequencyUnit || "days";
  const perUnit = unit === "months" ? 30 : unit === "weeks" ? 7 : 1;
  return value * perUnit;
}
async function checkDailyCoachCheckins() {
  const cfg = getConfig();
  if (!cfg.dailyCheckinEnabled) return;
  const timeZone = cfg.dailyCheckinTimezone || DEFAULT_DAILY_CHECKIN_TIMEZONE;
  const [targetHour, targetMinute] = (cfg.dailyCheckinTime || DEFAULT_DAILY_CHECKIN_TIME).split(":").map(Number);
  // Too early in the day for today's send yet -- every user, already-sent
  // or not, gets skipped this poll rather than checked one by one.
  const nowMinutes = currentMinutesInZone(timeZone), targetMinutes = targetHour * 60 + targetMinute;
  if (nowMinutes < targetMinutes) return;
  // ...and only within 3 hours after it, so a student skipped for recent
  // activity (below) gets their check-in at the usual time on a later day,
  // never late at night.
  if (nowMinutes > targetMinutes + 180) return;
  const today = todayInZone(timeZone);
  const requiredDays = dailyCheckinRequiredDays(cfg);
  const quietValue = Math.max(0, Number(cfg.dailyCheckinQuietValue) || 0);
  const quietMs = quietValue * (cfg.dailyCheckinQuietUnit === "hours" ? 3600000 : 86400000);
  const users = readJson(USERS_FILE, []);
  const convos = readJson(CONVOS_FILE, []);
  const staffIds = users.filter(u => !u.archived && (isAdmin(u) || u.role === "coach")).map(u => u.id);
  let changed = false;
  for (const user of users) {
    if (user.archived || !isClientRole(user.role)) continue;
    // Never sent before -- always eligible (first send). Otherwise only
    // once the configured cadence has actually elapsed since the last one,
    // not just "not already sent today" -- a frequency of 1 day keeps the
    // original once-a-day behavior exactly, since dailyCheckinRequiredDays
    // returns 1 in that case and this reduces to the same check.
    if (user.dailyCheckinSentDate && daysBetweenDateStrings(user.dailyCheckinSentDate, today) < requiredDays) continue;
    const convo = convos.find(c => c.autoGroupType === "student" && c.autoGroupUserId === user.id);
    if (!convo) continue;
    // The AI already said SKIP today -- don't ask again on the next poll.
    if (user.dailyCheckinSkippedDate === today) continue;
    // Any activity in the group (messages, videos, photos -- from the
    // student or a coach) within the quiet window means a conversation is
    // going; leave it alone. The previous automated check-in doesn't count.
    if (quietMs) {
      const lastActivity = MessagesDB.getConversationMessages(convo.id, { limit: 5 })
        .filter(m => m.id !== user.dailyCheckinLastMessageId).pop();
      if (lastActivity && Date.now() - new Date(lastActivity.createdAt).getTime() < quietMs) continue;
    }
    try {
      const text = await generateDailyCheckin(convo.id, user.id, cfg.dailyCheckinPrompt, cfg.dailyCheckinRule);
      if (!text) { user.dailyCheckinSkippedDate = today; changed = true; continue; }
      // Admin-configured "Sent As" (dailyCheckinSenderId), if set and that
      // person is actually a staff member currently in THIS student's
      // group -- otherwise the previous behavior (whichever coach/admin
      // happens to be first in the participant list, arbitrary and could
      // vary group to group) as a fallback for a student whose group
      // doesn't include the configured sender.
      const configuredSenderId = cfg.dailyCheckinSenderId && staffIds.includes(cfg.dailyCheckinSenderId) && convo.participantIds.includes(cfg.dailyCheckinSenderId)
        ? cfg.dailyCheckinSenderId : null;
      const senderId = configuredSenderId || convo.participantIds.find(id => staffIds.includes(id)) || staffIds[0] || user.id;
      const checkinId = randomUUID();
      MessagesDB.insertMessage({ id: checkinId, conversationId: convo.id, senderId, type: "text", text, createdAt: new Date().toISOString() });
      notifyParticipants(convo.id, senderId, { title: "New message", body: text.slice(0, 120), conversationId: convo.id }).catch(() => {});
      user.dailyCheckinSentDate = today;
      user.dailyCheckinLastMessageId = checkinId;
      changed = true;
    } catch (e) {
      console.error(`[daily checkin] user ${user.id} failed:`, e.message);
    }
  }
  if (changed) writeJson(USERS_FILE, users);
}
setInterval(() => {
  checkDailyCoachCheckins().catch(e => console.error("[daily checkins]", e.message));
}, 60 * 60 * 1000);

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

// A training-protocol video uploaded straight off an iPhone (picked from
// Photos, not recorded in-app) commonly arrives as video/quicktime with an
// uncompressed PCM audio track ("sowt") -- Safari plays that fine (it's
// QuickTime's own native format), but Chrome has no decoder registered for
// either the container's declared MIME type or that audio codec, and a
// <video> tag whose demuxer chokes on the audio track typically fails the
// whole element, not just the sound. Fixing just the audio (stream-copying
// the video track as-is) cleared it on Android/Chrome, but the SAME clips
// then started failing on iPhone -- the video stream itself turned out to
// carry `yuvj420p` (full-range colour signalled by the pixel-format name
// rather than a proper bitstream flag, a soft-deprecated convention), which
// every video that had NEVER had a problem on any device turned out to use
// plain `yuv420p` instead. Apple's hardware decoder (what Safari/WKWebView
// actually plays a <video> through) is far stricter about that than
// Chrome's software path, or than the QuickTime-specific decode path the
// original video/quicktime MIME type was quietly routing through before --
// relabelling the container to plain mp4 traded one device's leniency for
// another's. Re-encoding the video (not just stream-copying it) to a
// definite yuv420p, not just carrying over whatever the source happened to
// use, is what actually makes a given clip play everywhere at once.
// Chat video uploads: web-safe H.264 like remuxVideoForWeb, plus a 30fps cap
// (-fpsmax never raises a lower frame rate) and an optional trim in the same
// encode.
function convertChatVideoForWeb(inputPath, outputPath, trim) {
  const args = ["-y"];
  if (trim) args.push("-ss", String(Math.max(0, trim.start)));
  args.push("-i", inputPath);
  if (trim) args.push("-t", String(Math.max(0.1, trim.end - trim.start)));
  args.push(
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-fpsmax", "30",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero",
    "-f", "mp4", outputPath,
  );
  execFileSync(FFMPEG_EXE, args, { stdio: ["pipe", "pipe", "pipe"], timeout: 240000 });
}

// ── Chat video uploads, off the request path ───────────────────────────
// Converting with execFileSync blocked the whole server for every user
// (Nov 16: John Grippo's Day 1 clips froze the app ~1 min and the send took
// >3 min, so his phone gave up and nothing arrived). Now a send saves the
// file, posts the message at once with a first-frame thumbnail
// (posterFileId) and no driveFileId -- the app shows it with a spinner --
// and this converts + uploads in the background, one video at a time,
// filling in driveFileId when done.
function runFfmpegAsync(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_EXE, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (e) => e ? reject(e) : resolve());
  });
}
async function extractVideoFrameAsync(videoPath, seekSec, width) {
  const framePath = videoPath + "-" + randomUUID() + ".jpg";
  try {
    await runFfmpegAsync(["-y", "-ss", String(seekSec), "-i", videoPath, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", framePath], 30000);
    return readFileSync(framePath);
  } catch {
    if (seekSec > 0) {
      try {
        await runFfmpegAsync(["-y", "-i", videoPath, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", framePath], 30000);
        return readFileSync(framePath);
      } catch {}
    }
    return null;
  } finally { try { unlinkSync(framePath); } catch {} }
}
let chatVideoQueue = Promise.resolve();
function enqueueChatVideo(job) {
  const run = chatVideoQueue.then(() => processChatVideo(job));
  chatVideoQueue = run.catch(() => {});
  return run;
}
// How far a file's video / audio track actually runs, in seconds (reads the
// packets without decoding -- fast). null = no such track / unreadable.
function streamEndSec(path, sel) {
  return new Promise((resolve) => {
    execFile(FFMPEG_EXE, ["-hide_banner", "-i", path, "-map", sel, "-c", "copy", "-f", "null", "-"], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, (e, _out, stderr) => {
      const m = String(stderr || "").match(/time=(\d+):(\d+):([\d.]+)/g);
      if (!m) return resolve(null);
      const [h, mi, s] = m[m.length - 1].slice(5).split(":");
      resolve(+h * 3600 + +mi * 60 + +s);
    });
  });
}
// Picture track ends more than 1s before the sound? (Nov 24: three of
// Gabriel Almanza's clips came out of the 30fps-cap encode with the picture
// frozen at 4-14s while the sound ran 31-42s -- the conversion silently
// dropped every frame after some point in his phone's timestamps.)
async function videoCutShort(path) {
  const [v, a] = await Promise.all([streamEndSec(path, "0:v:0"), streamEndSec(path, "0:a:0")]);
  return { short: v != null && a != null && v < a - 1, v, a };
}
async function processChatVideo({ msgId, tempPath, ext, mimeType, trim, user, folderId }) {
  const webPath = tempPath + "-web.mp4";
  let sourcePath = tempPath, outExt = ext, outMime = mimeType;
  try {
    const encodeArgs = (frameArgs) => {
      const args = ["-y"];
      if (trim) args.push("-ss", String(Math.max(0, trim.start)));
      args.push("-i", tempPath);
      if (trim) args.push("-t", String(Math.max(0.1, trim.end - trim.start)));
      args.push("-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", ...frameArgs,
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", "-f", "mp4", webPath);
      return args;
    };
    try {
      await runFfmpegAsync(encodeArgs(["-fpsmax", "30"]), 15 * 60 * 1000);
      let check = await videoCutShort(webPath);
      if (check.short) {
        // Again without the frame-rate cap, keeping the phone's own frame timing.
        console.warn("[chat video] picture cut short", msgId, `video ${check.v}s / audio ${check.a}s -- re-encoding without the 30fps cap`);
        await runFfmpegAsync(encodeArgs(["-vsync", "passthrough"]), 15 * 60 * 1000);
        check = await videoCutShort(webPath);
      }
      if (check.short && !(await videoCutShort(tempPath)).short) {
        // Still short, but the original isn't: post the original untouched.
        console.warn("[chat video] still cut short", msgId, `video ${check.v}s / audio ${check.a}s -- sending the original file`);
      } else {
        sourcePath = webPath; outExt = ".mp4"; outMime = "video/mp4";
      }
    } catch (e) {
      console.error("[chat video convert]", e.message); // fall back to the original file
    }
    const frame = await extractVideoFrameAsync(sourcePath, 1, 512);
    const label = frame ? await guessContentLabel(frame, "image/jpeg") : "TRAINING VIDEO";
    const baseName = `${user.first} ${user.last} ${label}`.toUpperCase();
    const accessToken = await getDriveAccessToken();
    const result = await uploadStreamToDrive(createReadStream(sourcePath), { name: baseName + outExt, mimeType: outMime, folderId, accessToken });
    MessagesDB.updateMessageFields(msgId, { driveFileId: result.id, mimeType: outMime, driveFileName: baseName });
  } catch (e) {
    console.error("[chat video process]", msgId, e.message);
    try { MessagesDB.updateMessageFields(msgId, { text: "This video didn't finish uploading -- please send it again." }); } catch {}
  } finally {
    try { unlinkSync(tempPath); } catch {}
    try { unlinkSync(webPath); } catch {}
  }
}
try {
  const n = MessagesDB.failUnfinishedVideos();
  if (n) console.log("[chat video] marked", n, "unfinished video(s) from before restart as failed");
} catch (e) { console.error("[chat video] boot check", e.message); }

function remuxVideoForWeb(inputPath, outputPath) {
  execFileSync(FFMPEG_EXE, [
    "-y", "-i", inputPath,
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    "-f", "mp4", outputPath,
  ], { stdio: ["pipe", "pipe", "pipe"], timeout: 180000 });
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

// Cache of the training-protocol video library's full file list (id+name),
// keyed by folder id — same 5-minute-TTL idea as folderTreeCache above, so
// an AI-generate call doesn't re-walk + re-list a potentially large Drive
// folder tree on every single request.
const videoLibraryCache = new Map(); // folderId -> { files, expiresAt }
// The Drive folders searched for move videos (each with all its subfolders):
// the list set from the training protocol page's admin Settings, falling
// back to the single Chat Configuration folder.
function videoLibraryFolderIds(cfg = getConfig()) {
  const list = (cfg.trainingProtocolVideoLibraryFolderIds || []).map(extractDriveFolderId).filter(Boolean);
  return list.length ? list : [cfg.trainingProtocolVideoLibraryFolderId].filter(Boolean);
}
async function listVideoLibraryFiles(folderId, accessToken) {
  const cached = videoLibraryCache.get(folderId);
  if (cached && cached.expiresAt > Date.now()) return cached.files;
  const folderIds = await getAllDescendantFolderIds(folderId, accessToken);
  const parentsClause = folderIds.map(id => `'${id}' in parents`).join(" or ");
  const q = `(${parentsClause}) and mimeType contains 'video/' and trashed = false`;
  const files = [];
  let pageToken = "";
  // Cap at 10 pages (up to 10,000 files at pageSize 1000) -- far beyond any
  // realistic library size, just a sane ceiling against a runaway loop.
  for (let i = 0; i < 10; i++) {
    const pageTokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name)&pageSize=1000${pageTokenParam}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const d = await r.json();
    files.push(...(d.files || []));
    pageToken = d.nextPageToken || "";
    if (!pageToken) break;
  }
  videoLibraryCache.set(folderId, { files, expiresAt: Date.now() + 5 * 60 * 1000 });
  return files;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "to", "with", "on", "in", "for"]);
function moveNameTokens(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w && !STOPWORDS.has(w));
}
// Best-effort match of an AI-proposed movement name (e.g. "Straddle Flag
// Pullup") against the real video library's Drive filenames -- coaches'
// filenames are long and messy ("LEE NINJA STRENGTH Human Flag #10 Straddle
// Flag Pullup.mp4"), so this scores by how much of the move name's own
// words show up in the filename rather than requiring an exact/substring
// match either direction.
function matchVideoForMove(moveName, files) {
  const moveTokens = moveNameTokens(moveName);
  if (!moveTokens.length || !files.length) return null;
  let best = null, bestScore = 0;
  for (const f of files) {
    const nameTokens = new Set(moveNameTokens(f.name));
    const hits = moveTokens.filter(t => nameTokens.has(t)).length;
    const score = hits / moveTokens.length;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  // Require at least half the move name's words to actually show up --
  // below that it's just noise, better left as a plain text note than
  // attached to the wrong clip.
  return bestScore >= 0.5 ? best : null;
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
  // A named link ([name](url)) reads as just its name in the notification.
  if (payload && typeof payload.body === "string") payload = { ...payload, body: payload.body.replace(/\[([^\]\n]{1,160})\]\((https?:\/\/[^\s)]+)\)/g, "$1") };
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
          sound: payload.ring ? "ring.wav" : undefined,
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
          // payload.ring (incoming calls) goes to the app's "calls" channel
          // (MainActivity.createCallsChannel: ringtone + vibration). FCM falls
          // back to the default channel on builds that don't have it.
          android: { priority: "high", notification: { sound: "default", visibility: "public", icon: "ic_stat_notify", color: "#009BFF", ...(payload.ring ? { channelId: "calls" } : {}) } },
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
// A coach/admin moved to user/student leaves every team chat: a hand-made
// group (or channel) where everyone else is staff. Only their membership
// goes -- their past messages stay in the history -- so the chat drops out
// of their list, they can't open it, and their name leaves its member list.
// Auto groups (student/self) are managed by syncDefaultGroups instead.
function pullFromStaffOnlyChats(userId, users) {
  const byId = new Map(users.map(u => [u.id, u]));
  const convos = readJson(CONVOS_FILE, []);
  let changed = 0;
  for (const c of convos) {
    if (c.type !== "group" || c.autoGroupType || !c.participantIds.includes(userId)) continue;
    const others = c.participantIds.filter(id => id !== userId).map(id => byId.get(id)).filter(Boolean);
    if (!others.length || !others.every(isStaff)) continue;
    c.participantIds = c.participantIds.filter(id => id !== userId);
    changed++;
  }
  if (changed) writeJson(CONVOS_FILE, convos);
  return changed;
}
export function isClientRole(role) { return role === "online" || role === "gym"; }

// ── Trainees (Powerbatics Handstand Protocol buyers) ─────────────────────
// A $17 course buyer: sees only their protocol and one "<First Last> Group"
// with Lee + Alexis -- never a student (no levels, katas, students panel,
// physique reminders, directory, default protocol or welcome message).
export function isTrainee(user) { return user?.role === "trainee"; }
const HANDSTAND_TEMPLATE_NAME = "Powerbatics Handstand Protocol";
// Every low-ticket product the CRM sells (crm-app challenge_backend.js +
// product_funnel.js), keyed by sku: the program template a buyer gets and
// the add-on keys that product's checkout can send. Add-on keys are unique
// across products (they all live in user.hcBumps). A bridge call without a
// product is the Handstand Protocol (the CRM's original call).
const PRODUCTS = {
  hc21: { templateName: HANDSTAND_TEMPLATE_NAME, bumps: ["wrist", "shoulder", "hips"] },
  bsp21: { templateName: "Bodyweight Strength Protocol", bumps: ["bsp_knees", "bsp_spine", "bsp_neck"] },
};
const productOf = (sku) => PRODUCTS[String(sku || "hc21")] ? String(sku || "hc21") : null;
// Refund (CRM -> /api/bridge/trainee/revoke, or the Admin Panel's Refund):
// the Handstand Protocol and its add-ons come off the account; a Trainee
// (no other access) is also archived, so they can't log in. Students and
// staff keep their account and role.
function revokeHandstand(userId, reason, sku = "hc21") {
  const users = readJson(USERS_FILE, []);
  const u = users.find(x => x.id === userId);
  if (!u) return null;
  const prod = PRODUCTS[sku] || PRODUCTS.hc21;
  const all = readJson(TRAINING_PROTOCOLS_FILE, {});
  const rec = all[u.id];
  let programsLeft = 0;
  if (rec && Array.isArray(rec.programs)) {
    const ht = findProductTemplate(readJson(PROTOCOL_TEMPLATES_FILE, []), sku);
    const before = rec.programs.length;
    rec.programs = rec.programs.filter(e => !((ht && e.templateId === ht.id) || String(e.templateName || "").toLowerCase() === prod.templateName.toLowerCase()));
    if (rec.programs.length !== before) { all[u.id] = rec; writeJson(TRAINING_PROTOCOLS_FILE, all); }
    programsLeft = rec.programs.length;
  }
  // Only this product's add-ons come off (another product they bought keeps its own).
  u.hcBumps = (u.hcBumps || []).filter(b => !prod.bumps.includes(b));
  u.hcRefundedAt = new Date().toISOString();
  u.hcRefundReason = reason || "refund";
  // User Management > Trainees: "Make them a User on refund" (default on).
  // Students and staff who bought it keep their role and just lose the program;
  // a Trainee who still owns another product stays a Trainee.
  const makeUser = isTrainee(u) && !programsLeft && getConfig().traineeRefundMakeUser !== false;
  if (makeUser) u.role = "user";
  writeJson(USERS_FILE, users);
  if (makeUser) { syncDefaultGroups(); syncAppSheetRole(u).catch(e => console.error("[APP sheet role sync]", e.message)); }
  console.log(`[trainee] ${sku} program access removed ${u.id} role=${u.role}${makeUser ? " (made user)" : ""} reason=${u.hcRefundReason}`);
  return { userId: u.id, role: u.role, archived: !!u.archived, product: sku };
}
const TRAINEE_GROUP_OWNER_EMAIL = "lee@pacificrimathletics.com";
const HC_BUMP_KEYS = ["wrist", "shoulder", "hips"];
// Lee (by email) + Alexis (first name), active admins only; resolved at run
// time so no ids are hardcoded. Falls back to every admin if neither exists.
function traineeGroupStaffIds(users) {
  const admins = users.filter(u => !u.archived && isAdmin(u));
  const lee = admins.find(u => (u.email || "").trim().toLowerCase() === TRAINEE_GROUP_OWNER_EMAIL);
  const alexis = admins.filter(u => String(u.first || "").trim().toLowerCase() === "alexis");
  const ids = [lee, ...alexis].filter(Boolean).map(u => u.id);
  return ids.length ? Array.from(new Set(ids)) : admins.map(u => u.id);
}
function normalizeBumps(list, sku = "hc21") {
  const alias = { wrists: "wrist", shoulders: "shoulder", hip: "hips" };
  const keys = (PRODUCTS[sku] || PRODUCTS.hc21).bumps || HC_BUMP_KEYS;
  return Array.from(new Set((Array.isArray(list) ? list : [list]).map(b => String(b || "").trim().toLowerCase()).map(b => alias[b] || b).filter(b => keys.includes(b))));
}

// Program templates (e.g. the Handstand Protocol) carry protocol-level
// settings on the template record itself (template.settings) -- read live
// every time, so a change in Protocol Settings reaches every enrolled user.
const PROGRAM_SETTINGS_DEFAULTS = { dripEnabled: true, waitAmount: 1, waitUnit: "days", lockedText: "Unlocks in {time}", ctaUrl: "" };
// "Get the app" buttons shown in the program view (web only -- hidden inside the app itself).
const PROGRAM_APP_BUTTONS_DEFAULTS = {
  enabled: true, heading: "Get the app",
  iosLabel: "iPhone", iosUrl: "https://apps.apple.com/us/app/pacific-rim-athletics-app/id6799860403",
  androidLabel: "Android", androidUrl: "https://groups.google.com/g/pra-app-android",
  desktopLabel: "Desktop", desktopUrl: "https://www.pacificrimathletics.com/chat",
};
const DRIP_UNIT_MS = { minutes: 60000, hours: 3600000, days: 86400000 };
function programSettings(template) {
  const s = { ...PROGRAM_SETTINGS_DEFAULTS, ...(template?.settings || {}) };
  s.dripEnabled = s.dripEnabled !== false;
  s.waitAmount = Math.max(0, Number(s.waitAmount) || 0) || 1;
  if (!DRIP_UNIT_MS[s.waitUnit]) s.waitUnit = "days";
  s.lockedText = String(s.lockedText || PROGRAM_SETTINGS_DEFAULTS.lockedText);
  s.ctaUrl = String(s.ctaUrl || "");
  s.appButtons = { ...PROGRAM_APP_BUTTONS_DEFAULTS, ...(s.appButtons || {}) };
  s.appButtons.enabled = s.appButtons.enabled !== false;
  return s;
}
function sanitizeProgramSettings(input, current) {
  const next = { ...programSettings({ settings: current }) };
  if (!input || typeof input !== "object") return next;
  if (input.dripEnabled !== undefined) next.dripEnabled = !!input.dripEnabled;
  if (input.waitAmount !== undefined) { const n = Number(input.waitAmount); if (Number.isFinite(n) && n > 0 && n <= 10000) next.waitAmount = n; }
  if (input.waitUnit !== undefined && DRIP_UNIT_MS[input.waitUnit]) next.waitUnit = input.waitUnit;
  if (input.lockedText !== undefined) next.lockedText = String(input.lockedText).slice(0, 200) || PROGRAM_SETTINGS_DEFAULTS.lockedText;
  if (input.ctaUrl !== undefined) {
    const u = String(input.ctaUrl).trim();
    if (u && !/^https?:\/\//i.test(u)) throw new Error("CTA link must start with http:// or https://");
    next.ctaUrl = u.slice(0, 500);
  }
  // What the program view shows above the days (the template's real name stays fixed).
  if (input.kicker !== undefined) next.kicker = String(input.kicker).slice(0, 60);
  if (input.displayTitle !== undefined) next.displayTitle = String(input.displayTitle).slice(0, 120);
  // Daily-routine programs: "Move 1..21" in order instead of "Day N" newest-first (program-view.js).
  if (input.dayLabel !== undefined) next.dayLabel = String(input.dayLabel).slice(0, 20);
  if (input.dayOrder !== undefined) next.dayOrder = input.dayOrder === "asc" ? "asc" : "";
  if (input.bumpWhyLabel !== undefined) next.bumpWhyLabel = String(input.bumpWhyLabel).slice(0, 60);
  if (input.appButtons && typeof input.appButtons === "object") {
    const ab = { ...next.appButtons };
    if (input.appButtons.enabled !== undefined) ab.enabled = !!input.appButtons.enabled;
    for (const k of ["heading", "iosLabel", "androidLabel", "desktopLabel"]) if (input.appButtons[k] !== undefined) ab[k] = String(input.appButtons[k]).slice(0, 60);
    for (const k of ["iosUrl", "androidUrl", "desktopUrl"]) if (input.appButtons[k] !== undefined) {
      const u = String(input.appButtons[k]).trim();
      if (u && !/^https?:\/\//i.test(u)) throw new Error("App button links must start with http:// or https://");
      ab[k] = u.slice(0, 500);
    }
    next.appButtons = ab;
  }
  return next;
}
// A user's enrollments (programs[] on their TRAINING_PROTOCOLS_FILE record,
// separate from their own steps so an online student's custom protocol is
// never overwritten by a course they also bought).
function findProgramTemplate(templates, enr) {
  if (!enr) return null;
  return (enr.templateId && templates.find(t => t.id === enr.templateId))
    || templates.find(t => t.kind !== "student" && String(t.name || "").trim().toLowerCase() === String(enr.templateName || "").trim().toLowerCase())
    || null;
}
function findHandstandTemplate(templates) { return findProductTemplate(templates, "hc21"); }
// Low-ticket products (PRODUCTS) this account still has a program for --
// Mark Finished drops someone who owns one back to Trainee, not User.
function ownedLowTicketProducts(userId) {
  const rec = readJson(TRAINING_PROTOCOLS_FILE, {})[userId];
  if (!rec || !Array.isArray(rec.programs) || !rec.programs.length) return [];
  const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
  return Object.keys(PRODUCTS).filter(sku => {
    const ht = findProductTemplate(templates, sku);
    const name = PRODUCTS[sku].templateName.toLowerCase();
    return rec.programs.some(e => (ht && e.templateId === ht.id) || String(e.templateName || "").toLowerCase() === name);
  });
}
function findProductTemplate(templates, sku) {
  // User Management > Trainees: which program each product gives buyers.
  const mapped = getConfig().productPrograms?.[sku];
  const name = (PRODUCTS[sku] || {}).templateName;
  return (mapped && templates.find(t => t.id === mapped))
    || (name && templates.find(t => t.kind !== "student" && String(t.name || "").trim().toLowerCase() === name.toLowerCase())) || null;
}
// Same flattening as training-protocol.html's linearStepOrder: a day's whole
// below-chain finishes before the next day (its right neighbor) starts.
function linearProtocolSteps(list) {
  const kids = new Map();
  list.forEach(s => { const k = s.parentId || null; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(s); });
  const primary = n => (kids.get(n.id) || []).find(k => !k.isBranchRoot) || null;
  const below = n => (kids.get(n.id) || []).find(k => k.isBranchRoot) || null;
  const isLeaf = n => !primary(n) && !below(n);
  const out = [], seen = new Set();
  const visit = (n) => {
    if (seen.has(n.id)) return;
    seen.add(n.id); out.push(n);
    const next = primary(n), b = below(n), nextLeaf = next && isLeaf(next);
    if (nextLeaf) visit(next);
    if (b) visit(b);
    if (next && !nextLeaf) visit(next);
  };
  (kids.get(null) || []).forEach(visit);
  return out;
}
// Splits a program template into intro sections (everything before Day 1,
// headed by "section" steps) and days, with each day's drip state.
function buildProgramView(template, enr, { staffView, ownedBumps, now = Date.now() }) {
  const settings = programSettings(template);
  const order = linearProtocolSteps(template.steps || []).filter(s => s.type !== "placeholder");
  const sections = [], days = [];
  let cur = null;
  for (const s of order) {
    if (s.type === "day") { cur = { dayNumber: Number(s.dayNumber) || days.length + 1, title: s.title || "", category: s.category || "", timer: s.timer || null, steps: [] }; days.push(cur); continue; }
    if (s.type === "section") { cur = { title: s.title || s.content || "", chip: s.chip || "", steps: [] }; sections.push(cur); continue; }
    if (!cur) { cur = { title: "", steps: [] }; sections.push(cur); }
    cur.steps.push(s);
  }
  const startMs = Date.parse(enr?.startedAt || "") || now;
  const waitMs = settings.waitAmount * DRIP_UNIT_MS[settings.waitUnit];
  days.forEach(d => {
    d.unlocksAt = new Date(startMs + (d.dayNumber - 1) * waitMs).toISOString();
    d.unlocked = !settings.dripEnabled || !enr || startMs + (d.dayNumber - 1) * waitMs <= now;
  });
  const unlockedCount = days.filter(d => d.unlocked).length;
  let visibleDays = days;
  if (!staffView) {
    const firstLocked = days.find(d => !d.unlocked);
    visibleDays = days.filter(d => d.unlocked);
    // The next day shows as a locked card (title + countdown, no content);
    // anything after it isn't sent at all.
    if (firstLocked) visibleDays.push({ dayNumber: firstLocked.dayNumber, title: firstLocked.title, category: firstLocked.category, unlocked: false, unlocksAt: firstLocked.unlocksAt, steps: [] });
  }
  const owned = new Set(ownedBumps || []);
  const bumps = Object.entries(template.bumps || {})
    .filter(([key]) => staffView || owned.has(key))
    .map(([key, b]) => ({ key, title: b.title || key, intro: b.intro || "", moves: b.moves || [], owned: owned.has(key) }));
  return {
    templateId: template.id, name: template.name, goal: template.goal || "",
    startedAt: enr?.startedAt || null, settings, staffView: !!staffView,
    totalDays: days.length, unlockedCount, sections, days: visibleDays, bumps, now: new Date(now).toISOString(),
  };
}
// Whether a user's program enrollments make this Drive file theirs to
// stream: any step of an enrolled template, or a move in a bump they own.
function programOwnsFile(userId, userRecord, fileId, ownedBumps) {
  const programs = userRecord?.programs || [];
  if (!programs.length) return false;
  const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
  const owned = new Set(ownedBumps || []);
  return programs.some(enr => {
    const t = findProgramTemplate(templates, enr);
    if (!t) return false;
    if ((t.steps || []).some(s => s.driveFileId === fileId)) return true;
    return Object.entries(t.bumps || {}).some(([key, b]) => owned.has(key) && (b.moves || []).some(m => m.clip === fileId || m.driveFileId === fileId || m.image === fileId || m.handstandImage === fileId));
  });
}
// x-pra-app-key, compared in constant time (hashing first equalizes lengths).
function bridgeKeyOk(req) {
  const key = process.env.PRA_APP_BRIDGE_KEY;
  const given = req.headers["x-pra-app-key"];
  if (!key || typeof given !== "string" || !given) return false;
  const a = createHash("sha256").update(given).digest(), b = createHash("sha256").update(key).digest();
  return timingSafeEqual(a, b);
}
// Idempotent: adds a Handstand Protocol enrollment (startedAt = now) unless
// one exists; an existing one keeps its startedAt. Works before the template
// is installed (matched by name later). Returns the enrollment.
function enrollInHandstand(userId, source, sku = "hc21") {
  const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
  const template = findProductTemplate(templates, sku);
  const templateName = (PRODUCTS[sku] || PRODUCTS.hc21).templateName;
  const all = readJson(TRAINING_PROTOCOLS_FILE, {});
  const rec = all[userId] || {};
  const programs = Array.isArray(rec.programs) ? rec.programs : [];
  const nameKey = templateName.toLowerCase();
  let enr = programs.find(e => (template && e.templateId === template.id) || String(e.templateName || "").toLowerCase() === nameKey);
  let changed = false;
  if (!enr) {
    const now = new Date().toISOString();
    enr = { templateId: template?.id || null, templateName, startedAt: now, assignedAt: now, source: source || null, product: sku };
    programs.push(enr);
    changed = true;
  } else {
    if (!enr.startedAt) { enr.startedAt = new Date().toISOString(); changed = true; }
    if (!enr.templateId && template) { enr.templateId = template.id; changed = true; }
  }
  if (changed) { all[userId] = { ...rec, programs }; writeJson(TRAINING_PROTOCOLS_FILE, all); }
  return { enrollment: enr, templateInstalled: !!template };
}

// ── CRM bridge for the Students panel ───────────────────────────────────
const CRM_BASE_URL = process.env.CRM_BASE_URL || "https://crm-app-production-eb8f.up.railway.app";
function crmFetch(path, opts = {}) {
  const key = process.env.PRA_APP_BRIDGE_KEY;
  if (!key) return Promise.reject(new Error("CRM link not configured (PRA_APP_BRIDGE_KEY)"));
  return fetch(CRM_BASE_URL + path, { ...opts, headers: { ...(opts.headers || {}), "x-pra-app-key": key, "Content-Type": "application/json" } });
}
// ON HOLD students (Lee, 2026-11-22): yellow glow from 2 weeks before their
// resume / reconnect date until they're taken off hold (no longer ON HOLD
// in the CRM). Staff only, cached 2 minutes like the enrolled list.
let crmHoldCache = null; // { at, holds }
async function crmOnHoldContacts() {
  if (crmHoldCache && Date.now() - crmHoldCache.at < 2 * 60 * 1000) return crmHoldCache.holds;
  const all = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const r = await crmFetch(`/api/contacts?status=${encodeURIComponent("ON HOLD")}&limit=200&offset=${offset}`);
    if (!r.ok) throw new Error(`CRM returned ${r.status}`);
    const d = await r.json();
    all.push(...(d.contacts || []));
    if ((d.contacts || []).length < 200) break;
  }
  const holds = all.map(c => {
    const cf = c.customFields || {};
    const kind = cf.holdReconnectDate && !cf.holdResumeDate ? "reconnect" : "resume";
    return { email: String(c.email || "").trim().toLowerCase(), phone: last10(c.phone), key: c.first && c.last ? nameKey(c.first, c.last) : null, kind, ms: parseSheetDateMs(cf.holdResumeDate || cf.holdReconnectDate || "") };
  });
  crmHoldCache = { at: Date.now(), holds };
  return holds;
}
function holdForStudent(student, viewer, holds) {
  if (!holds || !student || !isStaff(viewer) || !isClientRole(student.role)) return null;
  if (getConfig().holdPillsStaff === false) return null;
  const em = String(student.email || "").trim().toLowerCase(), ph = last10(student.phone), key = nameKey(student.first, student.last);
  const h = holds.find(x => (em && x.email === em) || (ph && x.phone === ph) || (x.key && x.key === key));
  if (!h || h.ms == null || h.ms - alaskaTodayMs() > 14 * 86400000) return null;
  return { level: "yellow", kind: h.kind, date: new Date(h.ms).toISOString().slice(0, 10) };
}
let crmEnrolledCache = null; // { at, contacts }
async function crmEnrolledContacts(fresh = false) {
  if (!fresh && crmEnrolledCache && Date.now() - crmEnrolledCache.at < 2 * 60 * 1000) return crmEnrolledCache.contacts;
  const all = [];
  for (let offset = 0; offset < 10000; offset += 200) {
    const r = await crmFetch(`/api/contacts?status=ENROLLED&limit=200&offset=${offset}`);
    if (!r.ok) throw new Error(`CRM returned ${r.status}`);
    const d = await r.json();
    all.push(...(d.contacts || []));
    if ((d.contacts || []).length < 200) break;
  }
  const contacts = all.map(c => ({
    id: c.id, first: c.first || "", last: c.last || "", email: c.email || "", phone: c.phone || "", programType: (c.programType || "").toLowerCase(),
    // Family / couple enrollment (CRM enroll popup "Add names"): every
    // student on it, and "The Kiriakos". Empty for a one-person enrollment.
    familyMembers: parseFamilyMembers(c.customFields?.["family-members"], c.last),
    familyName: String(c.customFields?.["family-name"] || "").trim(),
  }));
  crmEnrolledCache = { at: Date.now(), contacts };
  syncFamilyLevelsRows(contacts).catch(e => console.error("[levels] family rows", e.message));
  return contacts;
}
// Every student on a CRM family/couple enrollment gets their own Levels row
// (Foundation, on the enrollment's Gym/Online tab) -- same as a new student
// does -- so each shows up in the Levels tab. At most every 10 minutes.
let familyRowsSyncedAt = 0;
async function syncFamilyLevelsRows(contacts) {
  if (getConfig().levelsRowOnNewStudent === false || Date.now() - familyRowsSyncedAt < 10 * 60 * 1000) return;
  familyRowsSyncedAt = Date.now();
  const families = contacts.filter(c => c.familyMembers.length && (c.programType === "gym" || c.programType === "online"));
  if (!families.length) return;
  const people = await fetchAllLevels();
  for (const c of families) {
    for (const m of c.familyMembers) {
      if (findLevelsEntries(people, m.first, m.last).length) continue;
      const key = nameKey(m.first, m.last);
      if (familyRowsInFlight.has(key)) continue;
      familyRowsInFlight.add(key);
      try {
        await updateLevelsRow({ first: m.first, last: m.last, program: c.programType === "online" ? "Online" : "Gym", levels: {}, team: false });
        people.push({ first: m.first, last: m.last, program: c.programType === "online" ? "Online" : "Gym", levels: {}, team: false });
        console.log("[levels] added Foundation row for family member", m.first, m.last, c.programType);
      } finally { familyRowsInFlight.delete(key); }
    }
  }
}
// Whatever CRM list is already in memory (refreshing it in the background
// when old) -- for request paths like the profile popup that shouldn't wait
// on several CRM pages. null until the first load finishes.
function crmEnrolledSnapshot() {
  if (!crmEnrolledCache || Date.now() - crmEnrolledCache.at >= 2 * 60 * 1000) crmEnrolledContacts().catch(() => {});
  return crmEnrolledCache?.contacts || null;
}
// "Nick Kiriako, Victoria Kiriako" -> [{first,last}...]. Same rules as the
// CRM's enroll-popup.js parseMemberList: the family's own last name stays
// whole even when it's several words, otherwise the last word is the last name.
function parseFamilyMembers(value, familyLast) {
  const fl = String(familyLast || "").trim();
  const out = String(value || "").split(/[,\n;]+/).map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean).map(full => {
    if (fl && full.toLowerCase().endsWith(" " + fl.toLowerCase())) return { first: full.slice(0, -fl.length - 1).trim(), last: full.slice(-fl.length) };
    const i = full.lastIndexOf(" ");
    return i > 0 ? { first: full.slice(0, i), last: full.slice(i + 1) } : { first: full, last: "" };
  }).filter(m => m.first && m.last);
  return out.length > 1 ? out : [];
}
// The CRM enrollment an app account belongs to: by email or phone (a shared
// family login), else by the account's own name being one of the students.
function crmEnrollmentFor(u, crm) {
  if (!crm || !u) return null;
  const em = String(u.email || "").trim().toLowerCase(), ph = last10(u.phone);
  const byLogin = crm.find(c => (em && c.email.trim().toLowerCase() === em) || (ph.length === 10 && last10(c.phone) === ph));
  if (byLogin) return { contact: byLogin, via: "login" };
  const key = String(u.first || "").trim() && String(u.last || "").trim() ? nameKey(u.first, u.last) : null;
  if (!key) return null;
  const byName = crm.find(c => nameKey(c.first, c.last) === key || c.familyMembers.some(m => nameKey(m.first, m.last) === key));
  return byName ? { contact: byName, via: "name" } : null;
}
// Whose Levels rows an app account shows: usually just its own name. A
// shared family/couple login ("Nick Victoria Kiriako") shows everyone on it:
//   1. people a coach linked by hand (u.levelsLinks),
//   2. the CRM enrollment's FAMILY MEMBERS when this is that enrollment's
//      login (same email/phone),
//   3. the account's first name split into names that each have a Levels
//      row with the same last name ("Nick Victoria" -> Nick + Victoria).
// Returns [{first,last}], always at least the account's own name.
function levelsPeopleForUser(u, people, crm = crmEnrolledSnapshot()) {
  const own = [{ first: String(u.first || "").trim(), last: String(u.last || "").trim() }];
  if (Array.isArray(u.levelsLinks) && u.levelsLinks.length) return u.levelsLinks.map(m => ({ first: m.first, last: m.last }));
  if (!isClientRole(u.role) && u.role !== "user") return own;
  const hit = crmEnrollmentFor(u, crm);
  if (hit && hit.via === "login" && hit.contact.familyMembers.length) {
    // Anyone on the family who has their own app account now uses that one.
    const others = new Set(readJson(USERS_FILE, []).filter(x => !x.archived && x.id !== u.id).map(x => nameKey(x.first, x.last)));
    const mine = hit.contact.familyMembers.filter(m => !others.has(nameKey(m.first, m.last)) || nameKey(m.first, m.last) === nameKey(u.first, u.last));
    if (mine.length) return mine;
  }
  if (people && own[0].first && own[0].last && !findLevelsEntries(people, own[0].first, own[0].last).some(e => Object.keys(e.levels || {}).length)) {
    const words = own[0].first.split(/\s+|&/).map(w => w.trim()).filter(w => w && !/^and$/i.test(w));
    if (words.length > 1) {
      const found = words.filter(w => findLevelsEntries(people, w, own[0].last).length).map(w => ({ first: w, last: own[0].last }));
      if (found.length > 1) return found;
    }
  }
  return own;
}
// Levels entries for an account, each tagged with whose they are. Family
// members with no Levels row yet get one (Foundation) in the background.
function levelsEntriesForUser(u, people) {
  const who = levelsPeopleForUser(u, people);
  const sheetEntries = () => who.flatMap(m => findLevelsEntries(people, m.first, m.last));
  if (u.levelsHistory && who.length <= 1 && !sheetEntries().length) {
    return [{ first: String(u.first || "").trim(), last: String(u.last || "").trim(), program: "", levels: u.levelsHistory, team: false, migrated: true }];
  }
  if (who.length > 1) who.forEach(m => { if (!findLevelsEntries(people, m.first, m.last).length) ensureFamilyLevelsRow(m, u).catch(() => {}); });
  return who.flatMap(m => findLevelsEntries(people, m.first, m.last).map(e => ({ ...e, first: e.first.trim(), last: e.last.trim() })));
}
const familyRowsInFlight = new Set();
async function ensureFamilyLevelsRow(m, u) {
  if (getConfig().levelsRowOnNewStudent === false) return;
  const key = nameKey(m.first, m.last);
  if (familyRowsInFlight.has(key)) return;
  familyRowsInFlight.add(key);
  try {
    levelsCache = null;
    const people = await fetchAllLevels();
    if (findLevelsEntries(people, m.first, m.last).length) return;
    const crmProgram = crmEnrollmentFor(u, crmEnrolledSnapshot())?.contact.programType;
    const program = (crmProgram || u.role) === "online" ? "Online" : "Gym";
    await updateLevelsRow({ first: m.first, last: m.last, program, levels: {}, team: false });
    console.log("[levels] added Foundation row for family member", m.first, m.last, program);
  } finally { familyRowsInFlight.delete(key); }
}
const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
async function crmFindContactId(email, phone) {
  for (const q of [email, last10(phone)].filter(Boolean)) {
    const r = await crmFetch(`/api/contacts?q=${encodeURIComponent(q)}&limit=5`);
    if (!r.ok) continue;
    const list = (await r.json()).contacts || [];
    const hit = list.find(c => (email && (c.email || "").toLowerCase() === String(email).toLowerCase()) || (last10(phone) && last10(c.phone) === last10(phone)));
    if (hit) return hit.id;
  }
  return null;
}
// Buckets for the Students panel. "On iPhone/Android" = the app is installed
// on their phone (an iPhone/Android push registration exists).
function buildStudentsOverview(crm, crmError, sheet, levelsPeople = null) {
  // Every live account; the student/rogue/trainee buckets work off `users`,
  // staff only ever count toward "All App Users" (Lee, 2026-11-24).
  const allAccounts = readJson(USERS_FILE, []).filter(u => !u.archived);
  const users = allAccounts.filter(u => ["user", "online", "gym", "trainee"].includes(u.role));
  const platforms = new Map();
  for (const s of readJson(PUSH_FILE, [])) if (s.nativeToken?.platform) { const set = platforms.get(s.userId) || new Set(); set.add(s.nativeToken.platform); platforms.set(s.userId, set); }
  const userByEmail = new Map(users.map(u => [(u.email || "").toLowerCase(), u]));
  const userByPhone = new Map(users.filter(u => last10(u.phone)).map(u => [last10(u.phone), u]));
  const crmByEmail = new Map(crm.filter(c => c.email).map(c => [c.email.toLowerCase(), c]));
  const crmByPhone = new Map(crm.filter(c => last10(c.phone)).map(c => [last10(c.phone), c]));
  const fromUser = (u) => {
    const c = crmByEmail.get((u.email || "").toLowerCase()) || (last10(u.phone) && crmByPhone.get(last10(u.phone))) || null;
    return { name: `${u.first || ""} ${u.last || ""}`.trim(), email: u.email || "", phone: u.phone || "", appUserId: u.id, role: u.role, platforms: [...(platforms.get(u.id) || [])], crmContactId: c?.id || null, programType: c?.programType || null, enrolled: !!c };
  };
  const fromCrm = (c) => {
    const u = userByEmail.get(c.email.toLowerCase()) || (last10(c.phone) && userByPhone.get(last10(c.phone))) || null;
    // CRM name, else the kickoff/buyers sheet's, else their app account's.
    const name = `${c.first} ${c.last}`.trim()
      || sheet?.namesByEmail?.get(c.email.toLowerCase()) || (last10(c.phone) && sheet?.namesByPhone?.get(last10(c.phone)))
      || (u ? `${u.first || ""} ${u.last || ""}`.trim() : "");
    return { name, email: c.email, phone: c.phone, crmContactId: c.id, programType: c.programType || null, enrolled: true, appUserId: u?.id || null, role: u?.role || null, platforms: [...(u ? platforms.get(u.id) || [] : [])] };
  };
  // Students = ENROLLED with an Online or Gym program; enrolled contacts with
  // no program set aren't counted (Lee: max is online + gym).
  // A family/couple enrollment counts every student on it (CRM FAMILY
  // MEMBERS): one item each, on their own app account when they have one,
  // else on the family's shared login.
  const userByName = new Map(users.map(u => [nameKey(u.first, u.last), u]));
  const crmItems = crm.flatMap(c => {
    const base = fromCrm(c);
    if (!c.familyMembers?.length) return [base];
    return c.familyMembers.map(m => {
      const u = userByName.get(nameKey(m.first, m.last)) || (base.appUserId ? users.find(x => x.id === base.appUserId) : null);
      return { ...base, name: `${m.first} ${m.last}`, family: c.familyName || "", appUserId: u?.id || null, role: u?.role || null, platforms: [...(u ? platforms.get(u.id) || [] : [])] };
    });
  }).filter(i => i.programType === "online" || i.programType === "gym")
    // A family member who also has their own CRM contact (the Roviras) counts once.
    .filter((i, idx, arr) => !i.name || arr.findIndex(x => nameKey(...x.name.split(/ (?=[^ ]+$)/)) === nameKey(...i.name.split(/ (?=[^ ]+$)/))) === idx);
  // Same on the app side: a shared family login is one item per person on it.
  const appItems = users.flatMap(u => {
    const base = fromUser(u);
    const who = levelsPeopleForUser(u, levelsCache?.people || null, crm);
    return who.length > 1 ? who.map(m => ({ ...base, name: `${m.first} ${m.last}`, family: `${u.first || ""} ${u.last || ""}`.trim() })) : [base];
  });
  const onPhone = appItems.filter(i => i.platforms.length);
  // "All" (Lee, 2026-11-24): every Online/Gym buyer on record -- CRM, buyer
  // sheets, old buyer sheets, kickoff calls, rosters, GoTeamUp emails
  // (chat_history_students.json, blacklist already left out) -- plus every
  // app account, staff included. A history person who already has an app
  // account counts once, as that account.
  const levelsMatch = (name) => { if (!levelsPeople || !name) return false; const parts = name.split(/ (?=[^ ]+$)/); return parts.length === 2 && findLevelsEntries(levelsPeople, parts[0], parts[1]).length > 0; };
  const everyAccount = allAccounts.map(fromUser);
  const acctEmail = new Set(allAccounts.map(u => String(u.email || "").toLowerCase()).filter(Boolean));
  const acctPhone = new Set(allAccounts.map(u => last10(u.phone)).filter(p => p.length === 10));
  const acctName = new Set(allAccounts.filter(u => u.first && u.last).map(u => nameKey(u.first, u.last)));
  const historyItems = (readJson(HISTORY_STUDENTS_FILE, { people: [] }).people || [])
    .filter(h => !((h.email && acctEmail.has(h.email)) || (h.phone && acctPhone.has(h.phone)) || (h.first && h.last && acctName.has(nameKey(h.first, h.last)))))
    .map(h => ({ name: `${h.first || ""} ${h.last || ""}`.trim(), email: h.email || "", phone: h.phone || "", appUserId: null, role: null, platforms: [],
      crmContactId: h.crmContactId || null, programType: (h.programs || [])[0] || null, enrolled: h.crmStatus === "ENROLLED", history: true, sources: h.sources || [],
      role: "rogue", levels: Object.keys(h.levels || {}).length > 0 }));
  const allItems = [...everyAccount, ...historyItems].map(i => ({ ...i, levels: i.levels || levelsMatch(i.name) }));
  const byName = (a) => a.sort((x, y) => x.name.localeCompare(y.name));
  // [key, name, source, items] -- the panel lines up the (source) column.
  // "On App" = the app is installed on their phone (iPhone/Android).
  // "Rogues" = accounts with the plain "user" role (Lee's name for them).
  const buckets = [
    ["all", "All", "", allItems],
    ["crm_all", "All Students", "CRM", crmItems],
    ["app_students", "All Students on App", "", onPhone.filter(i => i.role === "online" || i.role === "gym")],
    ["crm_online", "Online Students", "CRM", crmItems.filter(i => i.programType === "online")],
    ["app_online", "Online Students on App", "", onPhone.filter(i => i.role === "online")],
    ["crm_gym", "Gym Students", "CRM", crmItems.filter(i => i.programType === "gym")],
    ["app_gym", "Gym Students on App", "", onPhone.filter(i => i.role === "gym")],
    ["trainees", "Trainees", "", appItems.filter(i => i.role === "trainee")],
    ["app_trainees", "Trainees on App", "", onPhone.filter(i => i.role === "trainee")],
    // "Ronin" = plain user accounts on the app; "Rogues" = past students migrated
    // from the records (accounts with no login yet, never contacted).
    ["app_users", "Ronin", "", onPhone.filter(i => i.role === "user")],
    ["rogues", "Rogues", "", historyItems.map(i => ({ ...i, levels: i.levels || levelsMatch(i.name) }))],
    // App account made but the app was never installed on a phone.
    ["unaccepted", "Unaccepted Invites", "", appItems.filter(i => !i.platforms.length)],
    // Checks: enrolled but no app account; app students not ENROLLED in the CRM.
    ["crm_no_app", "Students Not on App", "", crmItems.filter(i => !i.appUserId)],
    ["app_not_enrolled", "App Students Not in CRM", "", appItems.filter(i => (i.role === "online" || i.role === "gym") && !i.enrolled)],
  ].map(([key, name, source, items]) => ({ key, name, source, label: source ? `${name} (${source})` : name, count: items.length, items: byName(items) }));
  return { buckets, crmError };
}

// Everyone gets their own row in the chat sidebar: a one-person "notes to
// self" thread (autoGroupType "self"). Created lazily the first time their
// conversation list loads; a no-op read after that.
function ensureSelfConvo(user) {
  const convos = readJson(CONVOS_FILE, []);
  if (convos.some(c => c.autoGroupType === "self" && c.autoGroupUserId === user.id)) return;
  convos.push({ id: randomUUID(), type: "group", name: `${user.first} ${user.last}`.trim() + " (You)", participantIds: [user.id], autoGroupType: "self", autoGroupUserId: user.id, createdBy: user.id, createdAt: new Date().toISOString() });
  writeJson(CONVOS_FILE, convos);
}
let badgesCache = null;
// A person's "moves" = videos they uploaded. Coaches/admins only count videos
// posted in their OWN coaching group (autoGroupUserId === them) -- staff
// don't have one today, so their moves are empty.
function movesForUser(u, convos = readJson(CONVOS_FILE, [])) {
  const vids = MessagesDB.getVideosBySender(u.id);
  if (!isStaff(u)) return vids;
  const own = new Set(convos.filter(c => c.autoGroupType === "student" && c.autoGroupUserId === u.id).map(c => c.id));
  return vids.filter(m => own.has(m.conversationId));
}
const MOVE_LIKES_FILE = "chat_move_likes.json"; // { [videoMessageId]: [userId, ...] }
const KATAS_FILE = "chat_katas.json"; // { [videoMessageId]: { senderId, createdAt } } -- videos flagged as a kata on upload
const MOVE_LIKE_TIMES_FILE = "chat_move_like_times.json"; // { [videoMessageId]: { [userId]: likedAtISO } } -- when each heart was given
// Badges count the current calendar month only, restarting on the 1st in
// each person's own timezone. Food-log day keys are already local dates;
// timestamps get converted to the person's local "YYYY-MM".
const BADGE_DEFAULT_TZ = "America/Anchorage";
function monthKeyIn(tz, when = new Date()) {
  try { return new Date(when).toLocaleDateString("en-CA", { timeZone: tz }).slice(0, 7); }
  catch { return new Date(when).toLocaleDateString("en-CA", { timeZone: BADGE_DEFAULT_TZ }).slice(0, 7); }
}
function computeBadges() {
  const users = readJson(USERS_FILE, []).filter(u => !u.archived);
  const food = readJson("chat_food_log.json", {});
  const scans = readJson("chat_body_scans.json", {});
  const photos = readJson("chat_progress_photos.json", {});
  const monthOf = new Map(users.map(u => [u.id, monthKeyIn(u.timezone || BADGE_DEFAULT_TZ)]));
  const tzOf = new Map(users.map(u => [u.id, u.timezone || BADGE_DEFAULT_TZ]));
  const inMonth = (userId, when) => !!when && monthOf.has(userId) && monthKeyIn(tzOf.get(userId), when) === monthOf.get(userId);
  // Two days before the UTC month start covers every timezone's 1st.
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 2 * 86400000).toISOString();
  const recentVideos = MessagesDB.getVideoTimesSince(since);
  const convosForMoves = readJson(CONVOS_FILE, []);
  const ownGroups = new Map(); // staff only count videos in their own coaching group (see movesForUser)
  for (const c of convosForMoves) if (c.autoGroupType === "student") ownGroups.set(c.id, c.autoGroupUserId);
  const usersById = new Map(users.map(u => [u.id, u]));
  const movesBySender = new Map();
  for (const v of recentVideos) {
    const u = usersById.get(v.senderId);
    if (!u || !inMonth(u.id, v.createdAt)) continue;
    if (isStaff(u) && ownGroups.get(v.conversationId) !== u.id) continue;
    movesBySender.set(u.id, (movesBySender.get(u.id) || 0) + 1);
  }
  const katasBySender = new Map();
  for (const k of Object.values(readJson(KATAS_FILE, {}))) if (inMonth(k.senderId, k.createdAt)) katasBySender.set(k.senderId, (katasBySender.get(k.senderId) || 0) + 1);
  // Hearts received this month. Hearts given before like times were
  // recorded fall back to the move's own post date.
  const likeTimes = readJson(MOVE_LIKE_TIMES_FILE, {});
  const heartsBySender = new Map();
  for (const [messageId, likers] of Object.entries(readJson(MOVE_LIKES_FILE, {}))) {
    if (!likers?.length) continue;
    const m = MessagesDB.getMessageById(messageId);
    if (!m) continue;
    const n = likers.filter(id => inMonth(m.senderId, likeTimes[messageId]?.[id] || m.createdAt)).length;
    if (n) heartsBySender.set(m.senderId, (heartsBySender.get(m.senderId) || 0) + n);
  }
  const counts = {};
  for (const u of users) {
    const month = monthOf.get(u.id);
    const days = Object.entries(food[u.id] || {}).filter(([day]) => day.slice(0, 7) === month).map(([, entries]) => entries);
    counts[u.id] = {
      fuel: days.filter(entries => (entries || []).some(e => e.source !== "steps")).length,
      photos: (scans[u.id] || []).filter(x => x.driveFileId && x.type !== "move" && inMonth(u.id, x.createdAt)).length + (photos[u.id] || []).filter(x => x.driveFileId && inMonth(u.id, x.createdAt || x.date)).length,
      moves: movesBySender.get(u.id) || 0,
      steps: days.reduce((sum, entries) => sum + (entries || []).filter(e => e.source === "steps").reduce((a, e) => a + (Number(e.steps) || 0), 0), 0),
      hearts: heartsBySender.get(u.id) || 0,
      katas: katasBySender.get(u.id) || 0,
    };
  }
  return { counts, users };
}
// Who may see whose badges: everyone sees their own; Lee's are visible to
// nobody else; admin/admin2 only to admins; coaches only to staff.
const BADGE_OWNER_EMAIL = "lee@pacificrimathletics.com";
function canSeeBadges(viewer, target) {
  if (viewer.id === target.id) return true;
  if ((target.email || "").toLowerCase() === BADGE_OWNER_EMAIL) return false;
  if (target.role === "admin" || target.role === "admin2") return viewer.role === "admin" || viewer.role === "admin2";
  if (target.role === "coach") return isStaff(viewer);
  return true;
}
// Competition ranking (ties share a rank; zero never ranks) among only the
// people this viewer can see, so a hidden coach never takes a gold medal
// out of a student's view.
function rankBadgesFor(viewer, { counts, users }) {
  const visible = users.filter(u => counts[u.id] && canSeeBadges(viewer, u)).map(u => u.id);
  const out = {};
  for (const id of visible) out[id] = {};
  for (const cat of ["fuel", "photos", "moves", "katas", "steps", "hearts"]) {
    const sorted = visible.filter(id => counts[id][cat] > 0).sort((a, b) => counts[b][cat] - counts[a][cat]);
    let rank = 0, prev = null;
    sorted.forEach((id, i) => { const n = counts[id][cat]; if (n !== prev) { rank = i + 1; prev = n; } out[id][cat] = { n, rank }; });
    for (const id of visible) if (!out[id][cat]) out[id][cat] = { n: 0, rank: null };
  }
  return { users: out };
}

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
  // Collects groups created THIS run (not ones that already existed) so the
  // welcome message below only ever fires once per group, right when it's
  // first created — not on every later sync (role changes, roster drift,
  // etc. all re-run this same function and must never re-send it).
  const newlyCreatedGroups = [];
  function ensurePersonalGroup(person, autoType, staffIds) {
    const desired = Array.from(new Set([person.id, ...staffIds]));
    const name = `${titleCase(person.first)} ${titleCase(person.last)} Group`;
    let convo = convos.find(c => c.autoGroupType === autoType && c.autoGroupUserId === person.id);
    // User Management can switch off creating NEW student groups (existing ones stay).
    if (!convo && autoType === "student" && getConfig().studentGroupEnabled === false) return;
    if (!convo) {
      convo = { id: randomUUID(), type: "group", name, participantIds: desired, autoGroupType: autoType, autoGroupUserId: person.id, createdBy: null, createdAt: new Date().toISOString() };
      convos.push(convo);
      newlyCreatedGroups.push({ convo, person, staffIds });
    } else {
      convo.name = name;
      if (JSON.stringify([...convo.participantIds].sort()) !== JSON.stringify([...desired].sort())) {
        convo.participantIds = desired;
      }
    }
  }
  const traineeStaff = traineeGroupStaffIds(users);
  active.forEach(u => {
    // Plain "user" accounts (a free/unpaid signup) get no group at all —
    // only actually becoming an online/gym client creates one, including
    // every admin/admin2/coach.
    if (isClientRole(u.role)) ensurePersonalGroup(u, "student", [...adminIds, ...coachIds]);
    // Handstand Protocol trainee: their own group with Lee + Alexis only.
    // Left as-is (frozen) if they later become a student or user.
    else if (isTrainee(u)) ensurePersonalGroup(u, "trainee", traineeStaff);
    // Made a plain "user" again: pulled from their own coaching group (staff
    // keep it and its history). Going back to online/gym re-adds them above.
    else if (u.role === "user") {
      const own = convos.find(c => c.autoGroupType === "student" && c.autoGroupUserId === u.id);
      if (own?.participantIds.includes(u.id)) own.participantIds = own.participantIds.filter(id => id !== u.id);
    }
  });
  writeJson(CONVOS_FILE, convos);

  // The welcome message and the auto-applied student protocol are for
  // online/gym students only -- a trainee group starts empty.
  {
    const tcfg = getConfig();
    if (tcfg.traineeWelcomeEnabled && tcfg.traineeWelcomeText) {
      newlyCreatedGroups.filter(g => g.convo.autoGroupType === "trainee").forEach(({ convo, person, staffIds }) => {
        const senderId = staffIds[0] || person.id;
        // Each product has its own welcome (User Management > Trainees); empty = none.
        const byProduct = tcfg.traineeWelcomeByProduct || {};
        const sku = person.hcLastProduct || "hc21";
        const tpl = byProduct[sku] !== undefined ? byProduct[sku] : (sku === "hc21" ? tcfg.traineeWelcomeText : "");
        if (!String(tpl || "").trim()) return;
        const text = fillTemplate(tpl, { firstName: person.first, lastName: person.last, userId: person.id });
        MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "text", text, createdAt: new Date().toISOString() });
        notifyParticipants(convo.id, senderId, { title: "New message", body: pushText(text).slice(0, 120), conversationId: convo.id }).catch(() => {});
      });
    }
  }
  newlyCreatedGroups.splice(0, newlyCreatedGroups.length, ...newlyCreatedGroups.filter(g => g.convo.autoGroupType === "student"));
  if (newlyCreatedGroups.length) {
    const cfg = getConfig();
    if (cfg.welcomeMessageEnabled && cfg.welcomeMessageText) {
      newlyCreatedGroups.forEach(({ convo, person, staffIds }) => {
        // Sent "from" the first staff member in the group (an admin, since
        // adminIds always comes first in the list build above) rather than
        // the student themselves or no one — matches how every other
        // automated message in this file (appointment reminders, etc.)
        // always has a real staff sender.
        const senderId = staffIds[0] || person.id;
        const text = fillTemplate(cfg.welcomeMessageText, { firstName: person.first, lastName: person.last, userId: person.id });
        MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "text", text, createdAt: new Date().toISOString() });
        notifyParticipants(convo.id, senderId, { title: "New message", body: pushText(text).slice(0, 120), conversationId: convo.id }).catch(() => {});
      });
    }
    // Same "clone with fresh step/parent ids" shape as POST .../apply
    // (toAllBlank) -- reads the builder draft fresh each time rather than
    // a snapshot taken when the toggle was flipped, so editing the draft
    // later changes what the NEXT new student gets without needing the
    // toggle re-flipped.
    //
    // A saved student custom program under this person's first + last name
    // (kind:"student", see /api/chat/protocol-templates?kind=student) wins
    // over the auto-applied draft, toggle on or off -- someone who already
    // had a custom program on the old site gets it the moment they join.
    const allProtocols = readJson(TRAINING_PROTOCOLS_FILE, {});
    const draft = cfg.defaultProtocolEnabled ? allProtocols[BUILDER_PROTOCOL_ID] : null;
    const nameKey = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
    const savedTemplates = readJson(PROTOCOL_TEMPLATES_FILE, []);
    const studentPrograms = savedTemplates.filter(t => t.kind === "student" && Array.isArray(t.steps) && t.steps.length);
    const sharedNames = new Set(savedTemplates.filter(t => t.kind !== "student").map(t => String(t.name || "").trim().toLowerCase()));
    const cloneSteps = (src) => {
      const idMap = new Map();
      src.forEach(s => idMap.set(s.id, randomUUID()));
      return src.map(s => ({ ...s, id: idMap.get(s.id), parentId: s.parentId ? idMap.get(s.parentId) : null }));
    };
    let changed = false;
    const autoBuildList = [];
    newlyCreatedGroups.forEach(({ person }) => {
      const mine = studentPrograms.find(t => nameKey(t.studentName) === nameKey(`${person.first}${person.last}`));
      const existing = allProtocols[person.id];
      if (mine) {
        // Never over a custom protocol a coach already built for them (e.g.
        // a user promoted to online gets a new group) -- only empty or the
        // auto-applied draft.
        const nm = String(existing?.protocolName || "").trim().toLowerCase();
        const hasOwn = existing?.steps?.length && !sharedNames.has(nm) && !/simple (but brutal )?powerbatics basics/i.test(nm);
        if (hasOwn && existing.templateId !== mine.id) return;
        allProtocols[person.id] = { ...existing, steps: cloneSteps(mine.steps), protocolName: mine.name, templateId: mine.id, updatedAt: new Date().toISOString(), updatedBy: "auto-student-program" };
        changed = true;
        console.log(`[protocol] ${person.first} ${person.last}: applied their saved program "${mine.name}"`);
      } else {
        if (draft?.steps?.length) {
          allProtocols[person.id] = { ...existing, steps: cloneSteps(draft.steps), protocolName: draft.protocolName || null, updatedAt: new Date().toISOString(), updatedBy: null };
          changed = true;
        }
        // No saved program -- build one from their custom-site page (async;
        // replaces the default above only if nobody has touched it since).
        autoBuildList.push(person);
      }
    });
    if (changed) writeJson(TRAINING_PROTOCOLS_FILE, allProtocols);
    autoBuildList.forEach(person => autoBuildProtocolFromCustomPage(person).catch(e => console.error("[auto-build]", e.message)));
  }
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
  // Trainees only ever talk in their own group.
  if (isTrainee(creator)) return false;
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
// non-mine message it returns) — not just when the message is first sent,
// since this is a poll-based app with no push-to-device signal of its own.
// "Read" reuses the readState timestamp conversations already track for
// unread-badge counting: a message is read by someone once their own
// last-read-at for this conversation is at or after the message's
// createdAt.
// deliveredTo defaults to [] via `m.deliveredTo || []` rather than being
// set at creation time in each of the several message-creation call
// sites — one read-side default is simpler than keeping all of them in
// sync, and functionally identical (nothing reads it before the first
// GET stamps it anyway).
//
// Per-recipient, not a single blended verdict for the whole group — a
// group's tick used to require EVERY participant to have read a message
// before it went blue (or even delivered a single gray double-check before
// EVERY participant had merely fetched it), which meant one quiet/inactive
// member (an admin sitting in the group who never opens chat, say)
// permanently pinned every message at "sent" even after the person
// actually being talked to had read and replied. The in-thread bubble
// renders ONE tick per element of this array (chat.html's
// readReceiptTicksHtml) — a DM's array is always length 1, so it already
// behaves exactly like a normal 1:1 read receipt with zero extra logic.
function computeMessageReceipts(m, convo, users) {
  const recipients = convo.participantIds.filter(id => id !== m.senderId);
  return recipients.map(id => {
    const u = users.find(x => x.id === id);
    const delivered = (m.deliveredTo || []).includes(id);
    const lastReadAt = u?.readState?.[convo.id];
    const read = !!(lastReadAt && new Date(lastReadAt) >= new Date(m.createdAt));
    return { userId: id, first: u?.first || "", last: u?.last || "", delivered, read };
  });
}
// Single-glyph summary used ONLY for the sidebar's last-message preview
// tick, where there's room for exactly one small icon next to the
// timestamp, not a full per-person breakdown: read (blue) once anyone has
// read it, delivered (gray double-check) once anyone has it, sent (gray
// single-check) otherwise. The in-thread view never uses this — it renders
// computeMessageReceipts directly, one tick per person.
function computeMessageStatus(m, convo, users) {
  const receipts = computeMessageReceipts(m, convo, users);
  if (!receipts.length) return "sent";
  if (receipts.some(r => r.read)) return "read";
  if (receipts.some(r => r.delivered)) return "delivered";
  return "sent";
}

// ── Video calls ──────────────────────────────────────────────────────────
// One in-flight call per conversation at a time — /call/start is idempotent
// against this (returns the existing one instead of creating a second),
// and it's what a rejoin/refresh keys off of too.
// A call nobody picks up stops ringing after CALL_RING_MS and ends as
// missed -- without this, a caller who closed the app mid-ring left the call
// "ringing" forever. While it rings, the people being called get a ringing
// push (ring: true -- ring.wav on iOS, the "calls" channel on Android) at the
// start and again every CALL_RING_REPEAT_MS, so the phone rings even when the
// app isn't open.
const CALL_RING_MS = 60 * 1000;
const CALL_ACTIVE_MAX_MS = 4 * 60 * 60 * 1000;
const CALL_RING_REPEAT_MS = 30 * 1000; // the ring sound itself lasts ~28s
function expireRingingCalls() {
  const calls = readJson(CALLS_FILE, []);
  const now = Date.now();
  // Also any call still "active" hours later: both sides dropped (app killed,
  // connection lost) without either one hanging up, which otherwise leaves
  // the conversation stuck on that dead call.
  const expired = calls.filter(c =>
    (c.status === "ringing" && now - new Date(c.createdAt).getTime() > CALL_RING_MS) ||
    (c.status === "active" && now - new Date(c.startedAt || c.createdAt).getTime() > CALL_ACTIVE_MAX_MS));
  if (!expired.length) return;
  for (const c of expired) { c.status = "ended"; c.endedAt = new Date().toISOString(); }
  writeJson(CALLS_FILE, calls);
  expired.forEach(createCallMessage);
}
setInterval(() => { try { expireRingingCalls(); } catch (e) { console.error("[call expire]", e.message); } }, 10 * 1000);
function ringCallees(callId, caller) {
  const call = readJson(CALLS_FILE, []).find(c => c.id === callId);
  if (!call || call.status !== "ringing") return;
  const subs = readJson(PUSH_FILE, []);
  // In a student's coaching group only the student is being called -- the
  // other coaches/admins in that group don't need their phones ringing.
  const convo = readJson(CONVOS_FILE, []).find(c => c.id === call.conversationId);
  const callees = convo?.autoGroupType === "student" ? [convo.autoGroupUserId] : call.participantIds;
  const waiting = new Set(callees.filter(id => !call.joinedIds.includes(id) && !call.declinedIds.includes(id)));
  const targets = subs.filter(s => waiting.has(s.userId));
  sendPushToTargets(targets, {
    title: `${caller.first} ${caller.last}`.trim() + " is calling", body: "Incoming video call. Open the app to answer.", conversationId: call.conversationId, ring: true,
  }).catch(() => {});
}

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
  MessagesDB.insertMessage(msg);
  // Only the people actually called hear about it -- in a student's group
  // that's the student, not every coach in it (same rule as ringCallees).
  const convo = readJson(CONVOS_FILE, []).find(c => c.id === call.conversationId);
  const notifyIds = new Set((convo?.autoGroupType === "student" ? [convo.autoGroupUserId] : call.participantIds).filter(id => id !== call.initiatorId));
  sendPushToTargets(readJson(PUSH_FILE, []).filter(t => notifyIds.has(t.userId)), {
    title: "Video call", body: outcome === "missed" ? "Missed video call" : "Video call ended", conversationId: call.conversationId,
  }).catch(() => {});
}

// Transcribes the call's audio via OpenAI Whisper, then asks a chat model
// (system prompt is the admin-editable callSummaryPrompt) to turn that
// transcript into a short positive/encouraging bullet-point recap. Audio-
// only, extracted from the already-downloaded recording with ffmpeg (not
// the full video) — both because Whisper only needs sound, and because
// that's the only realistic way to stay under OpenAI's 25MB upload cap for
// anything longer than a short call. Returns null (never throws) on any
// failure — a transcription hiccup should never be the thing standing
// between a client and seeing their own recording land in chat.
async function summarizeCallRecording(videoPath, promptText) {
  const audioPath = videoPath + "-audio.mp3";
  try {
    execFileSync(FFMPEG_EXE, ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audioPath],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 180000 });
    const sizeBytes = statSync(audioPath).size;
    if (sizeBytes > 24 * 1024 * 1024) {
      console.error(`[call summary] audio too long to transcribe (${Math.round(sizeBytes / 1024 / 1024)}MB) -- skipping`);
      return null;
    }

    const form = new FormData();
    form.append("file", new Blob([readFileSync(audioPath)]), "call.mp3");
    form.append("model", "whisper-1");
    const transcribeRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form,
    });
    const transcribeData = await transcribeRes.json();
    if (!transcribeRes.ok) throw new Error(transcribeData.error?.message || "Transcription failed");
    const transcript = (transcribeData.text || "").trim();
    if (!transcript) return null; // silent/empty call -- nothing to summarize

    const summaryRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: promptText || DEFAULT_CALL_SUMMARY_PROMPT },
          { role: "user", content: `Here is the transcript of today's training call:\n\n${transcript}` },
        ],
        max_tokens: 500,
        temperature: 0.6,
      }),
    });
    const summaryData = await summaryRes.json();
    if (!summaryRes.ok) throw new Error(summaryData.error?.message || "Summary generation failed");
    return (summaryData.choices?.[0]?.message?.content || "").trim() || null;
  } catch (e) {
    console.error("[call summary]", e.message);
    return null;
  } finally {
    try { unlinkSync(audioPath); } catch {}
  }
}

// Fire-and-forget from the call's /end handler -- Daily finalizes a
// recording a few seconds after everyone leaves, not instantly, so this
// polls rather than blocking the HTTP response on it. Only ever called for
// a call that actually reached "active" (startedAt set); a call nobody
// answered has nothing to record.
// Marks a call's recording as handled in CALLS_FILE so the boot-time sweep
// (resumeCallRecordings) never processes it twice.
function markCallRecording(callId, fields) {
  const calls = readJson(CALLS_FILE, []);
  const c = calls.find(x => x.id === callId);
  if (!c) return;
  Object.assign(c, fields);
  writeJson(CALLS_FILE, calls);
}
const archivingCallIds = new Set();
async function archiveCallRecording(call) {
  if (archivingCallIds.has(call.id)) return;
  archivingCallIds.add(call.id);
  let tempPath = null;
  try {
    // Daily needs a while to process a long call (a 16-minute call wasn't
    // ready inside the old 2-minute window), so wait up to 15 minutes. If
    // Daily has no recording at all for a call that ended a while ago, there
    // never was one (or it was already archived) -- stop right away.
    let recording = null;
    for (let i = 0; i < 60; i++) {
      const list = await listDailyRecordings(call.dailyRoomName);
      recording = list.find(r => r.status === "finished");
      if (recording) break;
      const endedMinsAgo = call.endedAt ? (Date.now() - new Date(call.endedAt).getTime()) / 60000 : 0;
      if (!list.length && endedMinsAgo > 20) break;
      await new Promise(r => setTimeout(r, 15000));
    }
    if (!recording) {
      console.error("[call recording] no finished recording for room", call.dailyRoomName);
      markCallRecording(call.id, { recordingArchiveGaveUp: new Date().toISOString() });
      return;
    }

    const cfg = getConfig();
    if (!cfg.callRecordingsFolderId) { console.error("[call recording] no callRecordingsFolderId configured -- set it in the admin panel"); return; }

    const downloadLink = await getDailyRecordingAccessLink(recording.id);
    const driveDownloadRes = await fetch(downloadLink);
    if (!driveDownloadRes.ok || !driveDownloadRes.body) throw new Error("Could not fetch the finished recording from Daily");

    const users = readJson(USERS_FILE, []);
    const participants = call.participantIds.map(id => users.find(u => u.id === id)).filter(Boolean);
    const student = participants.find(u => isClientRole(u.role));
    // The coach who placed the call (not just the first staff member in the
    // group, which is usually an admin) names and "sends" the recording.
    const initiator = users.find(u => u.id === call.initiatorId);
    const coach = (initiator && isStaff(initiator)) ? initiator : participants.find(u => isStaff(u));
    const namePart = [student, coach].filter(Boolean).map(u => `${u.first} ${u.last}`).join(" ") || "Video Call";
    const dateStr = new Date(call.startedAt).toISOString().slice(0, 10);

    // Written to disk once (rather than streamed straight through to Drive
    // like every other upload in this file) because the summary step below
    // needs a second, local pass over the same bytes with ffmpeg -- Daily's
    // download link is a one-shot signed URL, not safely re-fetchable.
    tempPath = join(tmpdir(), `call-${call.id}.mp4`);
    await pipeline(Readable.fromWeb(driveDownloadRes.body), createWriteStream(tempPath));

    const accessToken = await getDriveAccessToken();
    const uploaded = await uploadStreamToDrive(createReadStream(tempPath), {
      name: `${namePart} ${dateStr}.mp4`, mimeType: "video/mp4", folderId: cfg.callRecordingsFolderId, accessToken,
    });

    // Now archived in Drive -- no reason to also keep paying Daily's own
    // storage rate for the same footage indefinitely.
    await deleteDailyRecording(recording.id).catch(() => {});

    // Drop the recording (and, if enabled, an AI recap right under it) into
    // the group it was called from -- same video-message-then-text-message
    // pairing the Online Level Test forward endpoint already uses elsewhere
    // in this file for "a video plus a caption right after it".
    if (call.conversationId) {
      const senderId = coach?.id || student?.id || call.initiatorId;
      const now = Date.now();
      MessagesDB.insertMessage({
        id: randomUUID(), conversationId: call.conversationId, senderId,
        type: "video", driveFileId: uploaded.id, mimeType: "video/mp4", name: uploaded.name,
        driveFileName: `${namePart} ${dateStr}`,
        createdAt: new Date(now).toISOString(),
      });
      // "Your session recording is ready" is for the student, not every coach in the group.
      const recConvo = readJson(CONVOS_FILE, []).find(c => c.id === call.conversationId);
      const recIds = new Set(recConvo?.autoGroupType === "student" ? [recConvo.autoGroupUserId] : call.participantIds);
      sendPushToTargets(readJson(PUSH_FILE, []).filter(t => recIds.has(t.userId)), {
        title: "Video call recording", body: "Your session recording is ready", conversationId: call.conversationId,
      }).catch(() => {});

      // Short calls (a quick check-in, a dropped connection) get no AI recap --
      // admin-set minimum, 2 minutes by default.
      const callSecs = call.startedAt && call.endedAt ? (new Date(call.endedAt) - new Date(call.startedAt)) / 1000 : 0;
      const longEnough = callSecs >= (Number(cfg.callSummaryMinMinutes) || 0) * 60;
      if (cfg.callSummaryEnabled && longEnough) {
        const summary = await summarizeCallRecording(tempPath, cfg.callSummaryPrompt);
        if (summary) {
          MessagesDB.insertMessage({
            id: randomUUID(), conversationId: call.conversationId, senderId,
            type: "text", text: summary, createdAt: new Date(now + 1).toISOString(),
          });
        }
      }
    }
    markCallRecording(call.id, { recordingArchivedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[call recording] archive failed for call", call.id, e.message);
  } finally {
    archivingCallIds.delete(call.id);
    if (tempPath) { try { unlinkSync(tempPath); } catch {} }
  }
}

// A deploy/restart kills an in-progress archive (it runs in the background
// after the call ends) with nothing to retry it. On boot, pick up any call
// from the last 3 days that recorded but was never archived or given up on.
async function resumeCallRecordings() {
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  const pending = readJson(CALLS_FILE, []).filter(c =>
    c.startedAt && c.endedAt && c.dailyRoomName && new Date(c.endedAt).getTime() > cutoff &&
    !c.recordingArchivedAt && !c.recordingArchiveGaveUp);
  for (const c of pending) {
    console.log("[call recording] resuming archive for call", c.id);
    await archiveCallRecording(c);
  }
}
// Production only (Railway volume): a local dev server shares the same live
// Daily key and must never pull -- and then delete -- a real recording.
if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  setTimeout(() => { resumeCallRecordings().catch(e => console.error("[call recording] resume failed", e.message)); }, 20000);
}

// ── Route handler ────────────────────────────────────────────────────────
export async function handleChatRequest(req, res, url) {
  const p = url.pathname;

  // Signed-out Gym booking page -- checked before anything that needs a session.
  if (await handlePublicGymRequest(req, res, url)) return true;
  if (await handlePublicLevelsRequest(req, res, url)) return true;

  // ─── CRM bridge: Handstand Protocol buyers ───────────────────────────────
  // Key-auth (x-pra-app-key = PRA_APP_BRIDGE_KEY), no session. POST creates
  // or upgrades the account and enrolls it; GET ?email= reports status.
  // Never overwrites an existing password; never sends email/SMS.
  // CRM status changes (crm-app contacts PATCH / flows): FINISHED makes an
  // Online/Gym student a plain User; BLACKLIST archives the account. Each is
  // switchable in User Management.
  // Public certificate image (unguessable link, for SMS/email/sharing).
  const certMatch = p.match(/^\/cert\/([a-f0-9]{24})\.(png|jpg)$/);
  if (certMatch && (req.method === "GET" || req.method === "HEAD")) {
    const file = join(CERT_DIR, certMatch[1] + "." + certMatch[2]);
    if (!existsSync(file)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { "Content-Type": certMatch[2] === "jpg" ? "image/jpeg" : "image/png", "Cache-Control": "public, max-age=31536000, immutable" });
    if (req.method === "HEAD") { res.end(); return true; }
    createReadStream(file).pipe(res); return true;
  }
  // CRM "8 CERTIFICATE" flow: is the level still up (not put back), and the certificate.
  if ((p === "/api/bridge/level-check" || p === "/api/bridge/certificate" || p === "/api/bridge/discount-card") && req.method === "POST") {
    if (!bridgeKeyOk(req)) return sendJson(res, 401, { error: "Bad key" });
    const b = await readJsonBody(req);
    let ev = readLevelEvents().events.find(e => e.id === b.eventId);
    // A test fired from the CRM builder has no real event: make a throwaway one.
    if (!ev && b.test && b.first && b.category) {
      const u = appUserForName(b.first, b.last);
      ev = { id: randomUUID(), test: true, first: b.first, last: b.last || "", program: b.program || "Gym", category: String(b.category).toUpperCase(), to: b.level ?? 1, userId: u?.id || null, detectedAt: new Date().toISOString(), status: "test" };
      const d = readLevelEvents(); d.events.push(ev); writeJson(LEVEL_EVENTS_FILE, d);
    }
    if (!ev) return sendJson(res, 404, { error: "Unknown level-up event" });
    try {
      if (p === "/api/bridge/level-check") {
        const cur = ev.test ? ev.to : await currentLevelFor(ev);
        const still = ev.test ? true : stillAdvanced(ev, cur);
        markLevelEvent(ev.id, { checkedAt: new Date().toISOString(), still, currentAtCheck: cur ?? "" });
        return sendJson(res, 200, { ok: true, still, current: cur ?? null, label: ev.label || levelLabel(ev.category, ev.to) });
      }
      if (p === "/api/bridge/discount-card") {
        const code = String(b.code || "").trim();
        if (!code) return sendJson(res, 400, { error: "No discount code set on the step" });
        const out = await issueDiscountCard(ev, { code, percent: Number(b.percent) || 30, storeUrl: String(b.storeUrl || "https://www.pacificrimathletics.com/shop"), postToApp: b.postToApp !== false, message: String(b.message || "") });
        return sendJson(res, 200, { ok: true, ...out, eventId: ev.id });
      }
      const out = await issueCertificate(ev, { postToApp: b.postToApp !== false, message: String(b.message || "") });
      return sendJson(res, 200, { ok: true, ...out, label: ev.label || levelLabel(ev.category, ev.to), eventId: ev.id });
    } catch (e) {
      console.error("[level-up] bridge", e.message);
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (p === "/api/bridge/student-status" && req.method === "POST") {
    const key = req.headers["x-pra-app-key"];
    if (!process.env.PRA_APP_BRIDGE_KEY || key !== process.env.PRA_APP_BRIDGE_KEY) return sendJson(res, 401, { error: "Bad key" });
    const { email, phone, status } = await readJsonBody(req);
    const cfg = getConfig();
    const users = readJson(USERS_FILE, []);
    const em = String(email || "").trim().toLowerCase();
    const ph = String(phone || "").replace(/\D/g, "").slice(-10);
    const u = users.find(x => em && String(x.email || "").trim().toLowerCase() === em)
      || users.find(x => ph.length === 10 && String(x.phone || "").replace(/\D/g, "").slice(-10) === ph);
    if (!u) return sendJson(res, 200, { ok: true, matched: false });
    const st = String(status || "").toUpperCase();
    let action = "none";
    if (st === "FINISHED" && cfg.crmFinishedSync !== false && isClientRole(u.role)) {
      u.role = "user"; action = "made-user";
      writeJson(USERS_FILE, users);
      pullFromStaffOnlyChats(u.id, users);
      syncDefaultGroups();
      syncAppSheetRole(u).catch(e => console.error("[APP sheet role sync]", e.message));
    } else if (st === "BLACKLIST" && cfg.crmBlacklistArchive !== false && ["user", "online", "gym", "trainee"].includes(u.role) && !u.archived) {
      u.archived = true; action = "archived";
      writeJson(USERS_FILE, users);
      const sessions = readJson(SESSIONS_FILE, {});
      Object.keys(sessions).forEach(t => { if (sessions[t].userId === u.id) delete sessions[t]; });
      writeJson(SESSIONS_FILE, sessions);
      syncDefaultGroups();
    }
    console.log(`[bridge student-status] ${u.first} ${u.last} ${st} -> ${action}`);
    return sendJson(res, 200, { ok: true, matched: true, action });
  }
  // CRM Enroll popup "No media" checkbox (2026-11-24): name shown as First L.
  // (publicUser), video feed off, Levels row moved to the NO MEDIA tab. Not on
  // the app yet -> remembered and applied when they sign up.
  if (p === "/api/bridge/no-media" && req.method === "POST") {
    if (!bridgeKeyOk(req)) return sendJson(res, 401, { error: "Bad key" });
    const { email, phone, first, last, programType, noMedia } = await readJsonBody(req);
    const em = String(email || "").trim().toLowerCase(), ph = last10(phone);
    const users = readJson(USERS_FILE, []);
    const hits = users.filter(x => !x.archived && ((em && String(x.email || "").trim().toLowerCase() === em) || (ph.length === 10 && last10(x.phone) === ph)));
    const pend = readJson(NO_MEDIA_FILE, { pending: {} }); pend.pending = pend.pending || {};
    for (const k of [em && "e:" + em, ph.length === 10 && "p:" + ph].filter(Boolean)) { if (noMedia) pend.pending[k] = true; else delete pend.pending[k]; }
    writeJson(NO_MEDIA_FILE, pend);
    hits.forEach(u => applyNoMedia(u, !!noMedia));
    if (hits.length) writeJson(USERS_FILE, users);
    const who = hits[0] || { first, last, role: String(programType || "").toLowerCase() === "gym" ? "gym" : "online" };
    let levels = "";
    try { levels = await moveLevelsRowNoMedia({ first: who.first || first, last: who.last || last, program: who.role === "gym" ? "Gym" : "Online", noMedia: !!noMedia }); }
    catch (e) { levels = "levels: " + e.message; console.error("[bridge no-media] levels", e.message); }
    publicLevelsCache = null;
    console.log(`[bridge no-media] ${first} ${last} -> ${noMedia ? "on" : "off"} | app users ${hits.length} | ${levels}`);
    return sendJson(res, 200, { ok: true, appUsers: hits.length, action: `${hits.length ? "app account updated" : "saved for sign-up"}; ${levels}` });
  }
  if (p === "/api/bridge/trainee/revoke") {
    if (!process.env.PRA_APP_BRIDGE_KEY) return sendJson(res, 503, { error: "Bridge not configured" });
    if (!bridgeKeyOk(req)) return sendJson(res, 401, { error: "Bad key" });
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST" });
    const body = await readJsonBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const u = readJson(USERS_FILE, []).find(x => (body.userId && x.id === String(body.userId)) || (email && String(x.email || "").trim().toLowerCase() === email));
    if (!u) return sendJson(res, 404, { error: "No app account" });
    const sku = productOf(body.product);
    if (!sku) return sendJson(res, 400, { error: "Unknown product" });
    return sendJson(res, 200, { ok: true, ...revokeHandstand(u.id, String(body.reason || "refund"), sku) });
  }
  if (p === "/api/bridge/trainee") {
    if (!process.env.PRA_APP_BRIDGE_KEY) return sendJson(res, 503, { error: "Bridge not configured" });
    if (!bridgeKeyOk(req)) return sendJson(res, 401, { error: "Bad key" });
    const users = readJson(USERS_FILE, []);
    const findByEmail = (email) => users.find(u => String(u.email || "").trim().toLowerCase() === email);
    if (req.method === "GET") {
      const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
      if (!email) return sendJson(res, 400, { error: "email is required" });
      const u = findByEmail(email);
      if (!u) return sendJson(res, 200, { exists: false });
      const sku = productOf(url.searchParams.get("product"));
      if (!sku) return sendJson(res, 400, { error: "Unknown product" });
      const rec = readJson(TRAINING_PROTOCOLS_FILE, {})[u.id];
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const ht = findProductTemplate(templates, sku);
      const enr = (rec?.programs || []).find(e => (ht && e.templateId === ht.id) || String(e.templateName || "").toLowerCase() === PRODUCTS[sku].templateName.toLowerCase());
      const template = findProgramTemplate(templates, enr);
      const view = enr && template ? buildProgramView(template, enr, { staffView: true, ownedBumps: u.hcBumps }) : null;
      return sendJson(res, 200, {
        exists: true, userId: u.id, role: u.role, archived: !!u.archived, bumps: u.hcBumps || [],
        enrolled: !!enr, startedAt: enr?.startedAt || null, templateInstalled: !!template,
        currentDay: view ? view.unlockedCount : null, totalDays: view ? view.totalDays : null,
        groupId: readJson(CONVOS_FILE, []).find(c => c.autoGroupType === "trainee" && c.autoGroupUserId === u.id)?.id || null,
      });
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: "A valid email is required" });
      const source = String(body.source || "").slice(0, 200) || null;
      const sku = productOf(body.product);
      if (!sku) return sendJson(res, 400, { error: "Unknown product" });
      const bumps = normalizeBumps(body.bumps, sku);
      let u = findByEmail(email);
      let created = false;
      if (!u) {
        // A checkout without a name still gets an account (named after the email).
        const first = String(body.first || "").trim() || email.split("@")[0], last = String(body.last || "").trim();
        const password = String(body.password || "");
        if (!password) return sendJson(res, 400, { error: "password is required to create an account" });
        const { salt, hash } = hashPassword(password);
        const now = new Date().toISOString();
        u = {
          id: randomUUID(), first, last, email, phone: String(body.phone || "").trim(),
          passwordSalt: salt, passwordHash: hash, role: "trainee",
          profilePictureFileId: null, ip: null, geo: null, createdAt: now,
          // Same durable record the signup route keeps; the course checkout
          // carries the Terms agreement for this account.
          termsAcceptedAt: now, createdVia: "crm-bridge", hcSource: source,
        };
        users.push(u);
        created = true;
      } else if (u.role === "user") {
        u.role = "trainee"; // staff/online/gym keep their role
      }
      if (!u.phone && body.phone) u.phone = String(body.phone).trim();
      u.hcBumps = Array.from(new Set([...(u.hcBumps || []), ...bumps]));
      u.hcLastProduct = sku;
      writeJson(USERS_FILE, users);
      const { enrollment, templateInstalled } = enrollInHandstand(u.id, source, sku);
      if (isTrainee(u)) syncDefaultGroups();
      console.log(`[bridge trainee] ${sku} ${created ? "created" : "updated"} ${u.id} role=${u.role} bumps=${u.hcBumps.join(",") || "-"}`);
      return sendJson(res, 200, { userId: u.id, created, passwordSet: created, role: u.role, bumps: u.hcBumps, startedAt: enrollment.startedAt, templateInstalled, product: sku, templateId: enrollment.templateId || null });
    }
    return sendJson(res, 405, { error: "GET or POST" });
  }

  // ─── Auth ───────────────────────────────────────────────────────────────
  // Public: login.html hides its Sign Up tab when sign-up is switched off.
  if (req.method === "GET" && p === "/api/auth/signup-status") {
    const c = getConfig();
    return sendJson(res, 200, { enabled: c.signupEnabled !== false, forgotPassword: c.forgotPasswordEnabled !== false, minPasswordLength: Number(c.minPasswordLength) || 8 });
  }
  if (req.method === "POST" && p === "/api/auth/signup" && getConfig().signupEnabled === false && readJson(USERS_FILE, []).length) {
    return sendJson(res, 403, { error: "Sign up is closed right now. Contact Pacific Rim Athletics to get access." });
  }
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
    { const minLen = Math.max(4, Number(getConfig().minPasswordLength) || 8);
      if (String(password).length < minLen) return sendJson(res, 400, { error: `Password must be at least ${minLen} characters` }); }
    // Guideline 1.2 requires agreement to no-tolerance terms BEFORE an
    // account is created — enforced server-side too since the checkbox
    // itself is just client-side HTML that a direct API call would skip.
    if (agreedToTerms !== "true" && agreedToTerms !== true) {
      return sendJson(res, 400, { error: "You must agree to the Terms of Use to create an account" });
    }

    const users = readJson(USERS_FILE, []);
    const dupReason = findDuplicateUserReason(users, { email, phone, first, last });
    if (dupReason) return sendJson(res, 409, { error: dupReason });
    const { salt, hash } = hashPassword(password);
    const ip = getClientIp(req);
    const geo = await geolocateIp(ip); // best-effort — null on failure/local IP, never blocks signup
    const user = {
      id: newUserId,
      first, last, email: String(email).trim().toLowerCase(), phone: phone || "",
      passwordSalt: salt, passwordHash: hash,
      // first-ever signup bootstraps the admin.
      // Lee's call, 2026-11-12: everyone signs up as a plain "user" -- a
      // coach upgrades current students by hand (the CRM and sheets aren't
      // reliable enough to grant access automatically).
      role: users.length === 0 ? "admin" : "user",
      profilePictureFileId: profilePictureFileId || null,
      ip, geo, // geo: { city, region, country, lat, lng } | null — used by the users map
      createdAt: new Date().toISOString(),
      // Only reachable once the agreedToTerms check above passed, so this
      // is always "now" -- a durable record of *when* they agreed, not
      // just that the gate was satisfied at signup (which itself wasn't
      // being persisted anywhere before this).
      termsAcceptedAt: new Date().toISOString(),
    };
    applyRogueRecord(user, findRogueRecord({ email: user.email, phone, first, last }));
    applyPendingNoMedia(user);
    users.push(user);
    writeJson(USERS_FILE, users);
    syncDefaultGroups();
    const token = createSession(user.id);
    setSessionCookie(res, token);
    const locationStr = geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(", ") : "";
    upsertAppSheetRow({ first, last, email: user.email, phone, ip, location: locationStr }).catch(e => console.error("[APP sheet sync]", e.message));
    const upgradedRole = await upgradeOnArrival(user.id);
    if (upgradedRole) user.role = upgradedRole;
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  }

  if (req.method === "POST" && p === "/api/auth/forgot-password") {
    if (getConfig().forgotPasswordEnabled === false) return sendJson(res, 403, { error: "Password reset is turned off -- contact Pacific Rim Athletics." });
    const { email } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    // Trimmed: phone keyboards/autofill often append a trailing space, which
    // silently matched no account (and the generic response below hides that).
    const emailNorm = String(email || "").trim().toLowerCase();
    let user = users.find(u => u.email.trim().toLowerCase() === emailNorm);
    // A migrated Rogue (past student with no login yet) asking for a reset:
    // their account is created right here (plain user, no password), then the
    // reset link below lets them set one. Only ever on their own request.
    if (!user && emailNorm) {
      const rogue = findRogueRecord({ email: emailNorm });
      if (rogue && rogue.first && rogue.last) {
        const { salt, hash } = hashPassword(randomBytes(24).toString("hex")); // unguessable until they set their own
        user = { id: randomUUID(), first: rogue.first, last: rogue.last, email: emailNorm, phone: rogue.phone || "", role: "user", createdAt: new Date().toISOString(), passwordSalt: salt, passwordHash: hash };
        applyRogueRecord(user, rogue);
        applyPendingNoMedia(user);
        users.push(user);
        writeJson(USERS_FILE, users);
        console.log("[password reset] made account for migrated rogue", emailNorm.replace(/^(.).*(@.*)$/, "$1***$2"));
      }
    }
    if (!user) console.log("[password reset] no account for", emailNorm.replace(/^(.).*(@.*)$/, "$1***$2"));
    // Always return the same generic response whether or not the email exists,
    // so this endpoint can't be used to enumerate registered accounts.
    if (user) {
      const resets = readJson(RESETS_FILE, {});
      const token = randomBytes(32).toString("hex");
      resets[token] = { userId: user.id, expiresAt: Date.now() + Math.max(5, Number(getConfig().resetLinkMinutes) || 60) * 60 * 1000 };
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
    const minLen = Math.max(4, Number(getConfig().minPasswordLength) || 8);
    if (!token || !newPassword || newPassword.length < minLen) {
      return sendJson(res, 400, { error: `A valid token and a password of at least ${minLen} characters are required` });
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
    const emailNorm = String(email || "").trim().toLowerCase(); // same trailing-space trim as forgot-password
    const user = users.find(u => u.email.trim().toLowerCase() === emailNorm);
    if (!user || !verifyPassword(password || "", user.passwordSalt, user.passwordHash)) {
      return sendJson(res, 401, { error: "Invalid email or password" });
    }
    if (user.archived) return sendJson(res, 403, { error: "This account has been archived." });
    const token = createSession(user.id);
    setSessionCookie(res, token);
    if (user.role === "user") { const upgradedRole = await upgradeOnArrival(user.id); if (upgradedRole) user.role = upgradedRole; }
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
    setSessionCookie(res, getCookie(req, "pra_session")); // keeps the login cookie from ever running out
    return sendJson(res, 200, { user: publicUser(user), access: accessFor(user), renewalNotice: await myRenewalNotice(user) });
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
    if (!["user", "online", "gym", "trainee"].includes(role)) return sendJson(res, 400, { error: "role must be 'user', 'online', 'gym', or 'trainee'" });
    const users = readJson(USERS_FILE, []);
    const target = users.find(u => u.id === quickRoleMatch[1]);
    if (!target) return sendJson(res, 404, { error: "User not found" });
    if (!["user", "online", "gym", "trainee"].includes(target.role)) return sendJson(res, 400, { error: "Can only switch between user/online/gym this way" });
    target.role = role;
    writeJson(USERS_FILE, users);
    if (role === "trainee") pullFromStaffOnlyChats(target.id, users);
    syncDefaultGroups();
    syncAppSheetRole(target).catch(e => console.error("[APP sheet role sync]", e.message)); ensureStudentLevelsRow(target).catch(e => console.error("[levels row]", e.message));
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

  // ─── Students panel (coaches/admins) ─────────────────────────────────────
  // Counts + lists comparing the CRM's ENROLLED contacts with app accounts,
  // and quick actions that change both sides. The CRM is reached with the
  // shared PRA_APP_BRIDGE_KEY (crm-app auth_backend.js praAppBridgeUser),
  // through its own contacts endpoints, so a status change there fires the
  // same opt-outs / Blacklist sheet / automations as doing it by hand.
  if (p === "/api/chat/students-overview" && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isStaff(me)) return sendJson(res, 403, { error: "Coaches and admins only" });
    let crm = [], crmError = null;
    try { crm = await crmEnrolledContacts(url.searchParams.get("fresh") === "1"); } catch (e) { crmError = e.message; }
    const sheet = await fetchStudentEligibility().catch(() => null);
    const levelsPeople = await fetchAllLevels().catch(() => null);
    return sendJson(res, 200, buildStudentsOverview(crm, crmError, sheet, levelsPeople));
  }
  // "Put on hold" from the sidebar long-press menu (Lee, 2026-11-22). Same
  // result as picking ON HOLD in the CRM: the CRM contact goes to ON HOLD with
  // the hold dates, the end date moves out by the length of the hold, and a
  // task lands on the resume/reconnect date. The CRM's "9 ON HOLD" flow then
  // updates the buyers sheet + CALLS TRACKING end date.
  if (p === "/api/chat/students/hold" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isStaff(me)) return sendJson(res, 403, { error: "Coaches and admins only" });
    const { appUserId, startDate, kind, date } = await readJsonBody(req);
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (!["resume", "reconnect"].includes(kind)) return sendJson(res, 400, { error: "Pick a resume date or a reconnect date" });
    if (!ymd.test(String(startDate || "")) || !ymd.test(String(date || ""))) return sendJson(res, 400, { error: kind === "resume" ? "A resume date is required" : "A reconnect date is required" });
    if (date <= startDate) return sendJson(res, 400, { error: "That date has to be after the hold starts" });
    const target = readJson(USERS_FILE, []).find(u => u.id === appUserId);
    if (!target || !["online", "gym"].includes(target.role)) return sendJson(res, 400, { error: "Only online or gym students can be put on hold." });
    const END_FIELD = "d49b092b-3054-4d5c-b7fa-d4ac32e9df3b";
    const long = (d) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    const asUtc = (v) => { const [y, m, d] = v.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
    const parseAny = (v) => { v = String(v || "").trim(); if (!v) return null; let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v); if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(v); if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(Date.UTC(y, +m[1] - 1, +m[2])); } const d = new Date(v + " UTC"); return isNaN(d) ? null : d; };
    try {
      let contact = null;
      for (const q of [target.email, last10(target.phone)].filter(Boolean)) {
        const r = await crmFetch(`/api/contacts?q=${encodeURIComponent(q)}&limit=5`);
        if (!r.ok) continue;
        contact = ((await r.json()).contacts || []).find(c => (target.email && (c.email || "").toLowerCase() === target.email.toLowerCase()) || (last10(target.phone) && last10(c.phone) === last10(target.phone)));
        if (contact) break;
      }
      if (!contact) return sendJson(res, 404, { error: "No matching CRM contact" });
      const cf = contact.customFields || {};
      const prevEndRaw = cf[END_FIELD] || cf.enrollEndDate || "";
      const prevEnd = parseAny(prevEndRaw);
      const start = asUtc(startDate), back = asUtc(date);
      const patch = { holdActive: "yes", holdKind: kind, holdStartDate: long(start), holdResumeDate: kind === "resume" ? long(back) : "", holdReconnectDate: kind === "reconnect" ? long(back) : "", holdPrevEndDate: prevEndRaw };
      let newEnd = "";
      if (prevEnd) { const d = new Date(prevEnd.getTime() + (back - start)); newEnd = long(d); patch.enrollEndDate = newEnd; patch[END_FIELD] = newEnd; }
      const r = await crmFetch(`/api/contacts/${encodeURIComponent(contact.id)}`, { method: "PATCH", body: JSON.stringify({ status: "ON HOLD", customFieldsPatch: patch }) });
      if (!r.ok) return sendJson(res, 502, { error: `CRM update failed (${r.status})` });
      const name = `${contact.first || ""} ${contact.last || ""}`.trim() || "Student";
      await crmFetch("/api/tasks", { method: "POST", body: JSON.stringify({
        contactId: contact.id, type: "task", dueAt: new Date(date + "T18:00:00Z").toISOString(),
        title: kind === "resume" ? `${name} resumes training today (on hold since ${long(start)}) -- set status back to Enrolled` : `Reconnect with ${name} about resuming training (on hold since ${long(start)})`,
      }) }).catch(() => {});
      crmEnrolledCache = null;
      return sendJson(res, 200, { ok: true, newEndDate: newEnd, prevEndDate: prevEndRaw });
    } catch (e) { return sendJson(res, 502, { error: `CRM update failed: ${e.message}` }); }
  }
  // Admin "Details" (Lee, 2026-11-24): the student's CRM contact card --
  // contact info, status, every custom field in the CRM popup's groups and
  // the color-coded enrollment / renewal / hold history -- read live from
  // the CRM each time and edited straight back into it, so both apps always
  // show the same record. Enrolled / On Hold keep their own popups (sale
  // recording / end-date move), so this panel never sets those directly.
  // The CRM's own Enrolled / Hold popups, used as-is by the Details panel:
  // their script files are fetched from the CRM (so they're always the same
  // code), and their API calls come through this admin-only proxy, which
  // passes the admin's name so the CRM records who did it.
  const crmScript = p.match(/^\/api\/chat\/crm-script\/(enroll-popup|hold-popup)\.js$/);
  if (crmScript && req.method === "GET") {
    const me = getSessionUser(req);
    if (!me || !isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    try {
      const r = await fetch(`${CRM_BASE_URL}/${crmScript[1]}.js`);
      if (!r.ok) throw new Error(String(r.status));
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await r.text());
    } catch (e) { return sendJson(res, 502, { error: `CRM script unavailable (${e.message})` }); }
  }
  if (p.startsWith("/api/chat/crm-proxy/")) {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    const target = p.slice("/api/chat/crm-proxy".length);
    const m = req.method;
    const ok = (m === "GET" && (target === "/api/calls-sheet/options" || /^\/api\/contacts\/[\w-]+$/.test(target)))
      || (m === "PATCH" && /^\/api\/contacts\/[\w-]+$/.test(target))
      || (m === "POST" && target === "/api/tasks");
    if (!ok) return sendJson(res, 403, { error: "Not available from the app" });
    try {
      const body = m === "GET" ? undefined : JSON.stringify(await readJsonBody(req));
      const r = await crmFetch(target, { method: m, body, headers: { "x-pra-app-actor": `${me.first || ""} ${me.last || ""}`.trim() } });
      const text = await r.text();
      if (m !== "GET") { crmEnrolledCache = null; crmHoldCache = null; }
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(text);
    } catch (e) { return sendJson(res, 502, { error: `CRM unreachable: ${e.message}` }); }
  }
  if (p === "/api/chat/crm-details" && (req.method === "GET" || req.method === "PATCH")) {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isAdmin(me)) return sendJson(res, 403, { error: "Admins only" });
    try {
      if (req.method === "GET") {
        const target = readJson(USERS_FILE, []).find(u => u.id === url.searchParams.get("appUserId"));
        if (!target) return sendJson(res, 404, { error: "No such app user" });
        let found = null;
        for (const q of [target.email, last10(target.phone)].filter(Boolean)) {
          const r = await crmFetch(`/api/contacts?q=${encodeURIComponent(q)}&limit=5`);
          if (!r.ok) continue;
          found = ((await r.json()).contacts || []).find(c => (target.email && (c.email || "").toLowerCase() === target.email.toLowerCase()) || (last10(target.phone) && last10(c.phone) === last10(target.phone)));
          if (found) break;
        }
        if (!found) return sendJson(res, 404, { error: `No CRM contact matches ${target.email || target.phone || "this user"}` });
        const [cr, fr, sr] = await Promise.all([crmFetch(`/api/contacts/${encodeURIComponent(found.id)}`), crmFetch("/api/custom-fields?entityType=contact"), crmFetch("/api/statuses").catch(() => null)]);
        const contact = cr.ok ? ((await cr.json()).contact || found) : found;
        const fields = fr.ok ? ((await fr.json()).fields || []) : [];
        const statuses = sr && sr.ok ? ((await sr.json()).statuses || []).map(s => s.label) : ["FINISHED", "POTENTIAL", "APPLICATION", "BOOKED", "CANCELLED", "RSVP'ed", "ENROLLED", "BLACKLIST", "LOW TICKET", "ON HOLD"];
        return sendJson(res, 200, { contact, fields, statuses, crmUrl: `${CRM_BASE_URL}/contact-detail.html?id=${encodeURIComponent(contact.id)}` });
      }
      const body = await readJsonBody(req);
      const id = String(body.contactId || "");
      if (!/^[\w-]{8,}$/.test(id)) return sendJson(res, 400, { error: "Missing contact" });
      const patch = {};
      for (const k of ["first", "last", "email", "phone", "accountName", "emailOptOut", "smsOptOut"]) if (k in body) patch[k] = body[k];
      if ("status" in body) {
        if (/^(ENROLLED|ON HOLD)$/i.test(String(body.status))) return sendJson(res, 400, { error: "Enrolled and On Hold have their own popups" });
        patch.status = String(body.status || "");
      }
      if (body.customFieldsPatch && typeof body.customFieldsPatch === "object") {
        patch.customFieldsPatch = {};
        for (const [k, v] of Object.entries(body.customFieldsPatch)) if (k !== "__proto__" && (v == null || typeof v === "string")) patch.customFieldsPatch[k] = v ?? "";
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: "Nothing to save" });
      const r = await crmFetch(`/api/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (!r.ok) return sendJson(res, 502, { error: `CRM save failed (${r.status})` });
      crmEnrolledCache = null; crmHoldCache = null;
      const d = await r.json().catch(() => ({}));
      return sendJson(res, 200, { ok: true, contact: d.contact || null });
    } catch (e) { return sendJson(res, 502, { error: `CRM unreachable: ${e.message}` }); }
  }
  if (p === "/api/chat/students-overview/action" && req.method === "POST") {
    const me = getSessionUser(req);
    if (!me) return sendJson(res, 401, { error: "Not logged in" });
    if (!isStaff(me)) return sendJson(res, 403, { error: "Coaches and admins only" });
    const { action, appUserId, crmContactId, email, phone } = await readJsonBody(req);
    if (!["make_user", "make_online", "make_gym", "blacklist"].includes(action)) return sendJson(res, 400, { error: "Unknown action" });
    const users = readJson(USERS_FILE, []);
    const target = appUserId ? users.find(u => u.id === appUserId) : null;
    if ((action === "make_online" || action === "make_gym") && !target) return sendJson(res, 400, { error: "They don't have an app account yet." });
    if (target && !["user", "online", "gym", "trainee"].includes(target.role)) return sendJson(res, 400, { error: "Only student/user accounts can be changed here." });
    const done = [];
    if (target) {
      if (action === "blacklist") {
        target.archived = true;
        writeJson(USERS_FILE, users);
        const sessions = readJson(SESSIONS_FILE, {});
        Object.keys(sessions).forEach(token => { if (sessions[token].userId === target.id) delete sessions[token]; });
        writeJson(SESSIONS_FILE, sessions);
        syncDefaultGroups();
        done.push("App account archived");
      } else {
        // Mark Finished: someone who still owns a low-ticket program (e.g. the
        // Handstand Protocol) goes back to Trainee instead of a plain User.
        const lowTicket = action === "make_user" ? ownedLowTicketProducts(target.id) : [];
        target.role = action === "make_user" ? (lowTicket.length ? "trainee" : "user") : action === "make_online" ? "online" : "gym";
        writeJson(USERS_FILE, users);
        if (target.role === "user" || target.role === "trainee") pullFromStaffOnlyChats(target.id, users);
        syncDefaultGroups();
        syncAppSheetRole(target).catch(e => console.error("[APP sheet role sync]", e.message)); ensureStudentLevelsRow(target).catch(e => console.error("[levels row]", e.message));
        done.push(`App role: ${target.role}${lowTicket.length ? ` (owns ${lowTicket.join(", ")})` : ""}`);
      }
    }
    // CRM side: FINISHED for make_user, BLACKLIST for blacklist.
    if (action === "make_user" || action === "blacklist") {
      let crmResult;
      try {
        const id = crmContactId || await crmFindContactId(email || target?.email, phone || target?.phone);
        if (!id) crmResult = "No matching CRM contact";
        else {
          const status = action === "make_user" ? "FINISHED" : "BLACKLIST";
          const r = await crmFetch(`/api/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
          crmResult = r.ok ? `CRM status: ${status}` : `CRM update failed (${r.status})`;
        }
      } catch (e) { crmResult = `CRM update failed: ${e.message}`; }
      done.push(crmResult);
      crmEnrolledCache = null;
      try {
        const sheetStatus = action === "make_user" ? "FINISHED" : "BLACKLIST";
        const n = await setKickoffSheetStatus({ email: email || target?.email, phone: phone || target?.phone, first: target?.first, last: target?.last }, sheetStatus);
        done.push(n ? `Buyers sheet: ${n} row${n === 1 ? "" : "s"} set to ${sheetStatus}` : "Buyers sheet: no rows to change");
      } catch (e) { done.push(`Buyers sheet update failed: ${e.message}`); }
    }
    return sendJson(res, 200, { ok: true, done, role: target?.role || null });
  }

  // ─── Media streaming proxy (Range-aware) ─────────────────────────────────
  // Handled before the generic /api/chat/ prefix guard below, since that
  // guard's own catch-all 404 would otherwise swallow this route first.
  const mediaMatch = p.match(/^\/api\/chat\/media\/([^/]+)$/);
  if (mediaMatch && (req.method === "GET" || req.method === "HEAD")) {
    const mediaUser = getSessionUser(req);
    // Temporary diagnostic alongside reportVideoError (training-protocol.html)
    // -- that one only shows what the BROWSER's <video> element saw
    // (MEDIA_ERR_SRC_NOT_SUPPORTED / NETWORK_NO_SOURCE on a real iPhone, no
    // readable error message), not whether this request even reached here
    // or who it arrived as. A real possibility for that exact symptom is
    // iOS's native video pipeline (AVFoundation, a separate process from
    // WKWebView's own fetch/XHR stack) not sharing the session cookie --
    // this line settles that one way or the other on the next retry. Has
    // the Cookie header's own presence/absence logged (not its value).
    console.log("[media request]", JSON.stringify({ method: req.method, fileId: mediaMatch[1], range: req.headers.range || null, hasCookieHeader: !!req.headers.cookie, authenticated: !!mediaUser, userAgent: req.headers["user-agent"] || "" }));
    // The request clearly reaches here fine (previous round of this same
    // diagnostic confirmed hasCookieHeader/authenticated both true every
    // time) and MEDIA_ERR_SRC_NOT_SUPPORTED/NETWORK_NO_SOURCE still happens
    // on the real device regardless -- so the open question now is what
    // this route actually SENT BACK for that exact request. Logs it once
    // the response is actually done, not just assumed from the code path.
    res.on("finish", () => {
      console.log("[media response]", JSON.stringify({ fileId: mediaMatch[1], statusCode: res.statusCode, contentType: res.getHeader("Content-Type"), contentLength: res.getHeader("Content-Length"), contentRange: res.getHeader("Content-Range"), acceptRanges: res.getHeader("Accept-Ranges") }));
    });
    if (!mediaUser) { res.writeHead(401); res.end(); return true; }
    const fileId = mediaMatch[1];
    // Only allow access if this file is attached to a message in a conversation
    // the requester participates in, or is someone's profile picture.
    const msg = MessagesDB.findMessageByDriveFileId(fileId) || MessagesDB.findMessageByPosterFileId(fileId);
    const allUsers = readJson(USERS_FILE, []);
    const isProfilePic = allUsers.some(u => u.profilePictureFileId === fileId);
    // Kata library videos: any signed-in student or staff member.
    let isKata = false;
    if (!isProfilePic && (isClientRole(mediaUser.role) || isStaff(mediaUser))) {
      try { isKata = (await fetchKataLibrary()).ids.has(fileId); } catch {}
    }
    // Training Protocol > Warmup tab: one video for every gym student.
    if (fileId === GYM_WARMUP_VIDEO_ID && (mediaUser.role === "gym" || isStaff(mediaUser))) isKata = true;
    if (!isProfilePic && !isKata) {
      if (msg) {
        const convos = readJson(CONVOS_FILE, []);
        const convo = convos.find(c => c.id === msg.conversationId);
        // A move (video) whose sender shows their moves publicly on their
        // profile is viewable by any signed-in user (profile moves history).
        const sender = allUsers.find(u => u.id === msg.senderId);
        const publicMove = msg.type === "video" && sender && movesVisible(sender)
          && (!isStaff(sender) || (convo?.autoGroupType === "student" && convo.autoGroupUserId === sender.id)); // same rule as movesForUser
        // Allowed if ANY message using this file is in a chat the viewer is
        // in -- checking only the first copy blocked everyone else in a bulk
        // send (the first copy can land in a chat they're not part of).
        const inAnyChat = () => MessagesDB.findMessagesByDriveFileId(fileId)
          .some(mm => convos.find(c => c.id === mm.conversationId)?.participantIds.includes(mediaUser.id));
        // A program clip can also have been posted in some chat (e.g. an
        // "Ask a Question" about it) -- an enrolled user still owns it.
        const inOwnProgram = () => programOwnsFile(mediaUser.id, readJson(TRAINING_PROTOCOLS_FILE, {})[mediaUser.id], fileId, mediaUser.hcBumps);
        if (!publicMove && !(convo && convo.participantIds.includes(mediaUser.id)) && !inAnyChat() && !inOwnProgram()) { res.writeHead(403); res.end(); return true; }
      } else {
        // Not a chat-message attachment — check whether it's a training-protocol
        // step's video/image (these are never posted as chat messages, so the
        // check above always missed them and every step video/image 404'd).
        const allProtocols = readJson(TRAINING_PROTOCOLS_FILE, {});
        // THE actual bug behind "videos won't play" reports that never
        // reproduced in any of my own testing: coaches constantly reuse the
        // same handful of library clips across many students' protocols
        // (confirmed directly -- the "Simple Powerbatics Basics Workout"
        // template alone is applied to ~20 different students, all sharing
        // the same 5 video fileIds). The OLD check here picked a single
        // global "owner" for a fileId (whichever student's record
        // Object.keys() happened to list first) and 403'd every OTHER
        // student who also legitimately has that exact fileId in their OWN
        // steps -- my own test accounts never hit this because I was
        // always either staff (bypasses it) or the lucky first owner.
        // Checking against the REQUESTING user's own protocol fixes it:
        // every student who actually has this fileId in their own steps is
        // allowed, not just one.
        // ...or a step/bump clip of a program they're enrolled in (Handstand
        // Protocol steps are read live from the template, never copied).
        const ownsIt = (allProtocols[mediaUser.id]?.steps || []).some(s => s.driveFileId === fileId)
          || (!isStaff(mediaUser) && programOwnsFile(mediaUser.id, allProtocols[mediaUser.id], fileId, mediaUser.hcBumps));
        if (!ownsIt && !isStaff(mediaUser)) {
          // Doesn't own it and isn't staff -- still distinguish "this
          // belongs to someone else's protocol" (403) from "not attached
          // anywhere yet" (404, the staff-only "Choose a Video" picker's
          // own preview case, which only ever reaches here for staff
          // anyway, but keeps the status code meaningful either way).
          const attachedAnywhere = Object.values(allProtocols).some(rec => (rec.steps || []).some(s => s.driveFileId === fileId));
          res.writeHead(attachedAnywhere ? 403 : 404); res.end(); return true;
        }
      }
    }
    try {
      const accessToken = await getDriveAccessToken();
      if (req.method === "HEAD") {
        // iOS's native video pipeline (what Safari/WKWebView actually plays
        // a <video> through, as opposed to Chrome's own) is documented to
        // probe a media URL with HEAD before ever issuing the real ranged
        // GET, to learn Content-Type/Content-Length/Accept-Ranges up front
        // -- this route never answered HEAD at all (fell through to every
        // other route's 404), which is a very plausible reason students on
        // iPhone kept seeing a poster frame but a permanently-disabled play
        // control even after the codec/container issues were fixed: the
        // probe itself was failing before playback was ever attempted.
        await streamDriveMediaHead(res, fileId, accessToken);
      } else {
        await streamDriveMedia(req, res, fileId, accessToken);
      }
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
  // The signed-in user's own latest result (type code + trait %s) for the
  // results page's "Your Traits" bars.
  if (p === "/api/personality-quiz/my-result" && req.method === "GET") {
    const user = getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: "Not logged in" });
    const email = (user.email || "").toLowerCase();
    const lead = email ? readJson(PERSONALITY_LEADS_FILE, []).find(l => (l.email || "").toLowerCase() === email) : null;
    return sendJson(res, 200, { result: lead ? { mbti: lead.mbti || "", code: lead.code || lead.mbti || "", traits: lead.traits || null, archetype: lead.archetype || "" } : null });
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
            contact.mbti ? `MBTI: ${contact.code || contact.mbti} ${contact.standard || ""}`.trim() : "",
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
      const cfg = readJson(PERSONALITY_CONFIG_FILE, {});
      // 2026-11-21: questions moved from the old "E5I1"-style answer codes
      // (lopsided: 7 J/P vs 2 T/F) to balanced { text, dim, agree } items
      // scored like 16Personalities. A Volume copy still on the old format
      // gets the bundled question set; its settings/archetypes are kept.
      // A higher bundled questionsVersion replaces the Volume's questions the
      // same way (v3 = 56 training-flavored items, 2026-11-21).
      const bundled = readAppJson(PERSONALITY_CONFIG_FILE, {});
      const outdated = (bundled.questionsVersion || 0) > (cfg.questionsVersion || 0);
      if (!Array.isArray(cfg.questions) || cfg.questions.some(q => q && q.values) || outdated) {
        if (Array.isArray(bundled.questions) && bundled.questions.length && !bundled.questions.some(q => q && q.values)) {
          cfg.questions = bundled.questions;
          cfg.questionsVersion = bundled.questionsVersion || 0;
          if (cfg.settings && cfg.archetypes) writeJson(PERSONALITY_CONFIG_FILE, cfg);
        }
      }
      return sendJson(res, 200, cfg);
    }
    if (req.method === "POST") {
      const user = getSessionUser(req);
      if (!user || !isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const cfg = await readJsonBody(req);
      if (!cfg.settings || !Array.isArray(cfg.questions) || !cfg.archetypes) return sendJson(res, 400, { error: "invalid config shape" });
      const DIMS = { EI: "EI", SN: "SN", TF: "TF", JP: "JP", AT: "AT" };
      if (cfg.questions.some(q => !q || typeof q.text !== "string" || !DIMS[q.dim] || !DIMS[q.dim].includes(q.agree))) {
        return sendJson(res, 400, { error: "each question needs text, a trait (EI/SN/TF/JP/AT) and which letter agreeing points to" });
      }
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

    // Trainees get their protocol and their own chats -- nothing else
    // (levels, katas, map, favorites, moves, physique, intake...).
    if (isTrainee(user)) {
      const own = encodeURIComponent(user.id);
      const allowed = p === "/api/chat/conversations" || p.startsWith("/api/chat/conversations/")
        || p === "/api/chat/contacts" || p.startsWith("/api/chat/me/") || p.startsWith("/api/chat/quickstart")
        || p === `/api/chat/training-protocol/${own}` || p === "/api/chat/training-protocol/video-error"
        || p === `/api/chat/protocol-program/${own}`
        || p.startsWith("/api/chat/profile/")
        || ["/api/chat/push-subscribe", "/api/chat/push-subscribe-native", "/api/chat/vapid-public-key", "/api/chat/active-conversation",
          "/api/chat/block", "/api/chat/unblock", "/api/chat/blocked", "/api/chat/report", "/api/chat/gifs"].includes(p);
      // Anything switched on for Trainees in User Management > Access.
      const acc = accessFor(user);
      const byAccess = (acc.katas && p.startsWith("/api/chat/katas")) || (acc.levels && p.startsWith("/api/chat/levels"))
        || (acc.map && p.startsWith("/api/chat/users-map")) || (acc.videos && (p.startsWith("/api/chat/moves") || p.startsWith("/api/chat/badges")))
        || (acc.physique && (p.startsWith("/api/chat/body") || p.startsWith("/api/chat/food") || p.startsWith("/api/chat/progress")));
      if (!allowed && !byAccess) return sendJson(res, 403, { error: "Not part of the Handstand Protocol" });
    }

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
        if (["user", "trainee", "online", "gym", "coach", "admin", "admin2"].indexOf(role) === -1) return sendJson(res, 400, { error: "role must be 'user', 'trainee', 'online', 'gym', 'coach', 'admin', or 'admin2'" });
        const users = readJson(USERS_FILE, []);
        const dupReason = findDuplicateUserReason(users, { email, phone, first, last });
        if (dupReason) return sendJson(res, 409, { error: dupReason });
        const { salt, hash } = hashPassword(password);
        const newUser = {
          id: randomUUID(),
          first, last, email: String(email).trim().toLowerCase(), phone: phone || "",
          passwordSalt: salt, passwordHash: hash,
          role,
          profilePictureFileId: null,
          ip: null, geo: null,
          createdAt: new Date().toISOString(),
        };
        users.push(newUser);
        writeJson(USERS_FILE, users);
        if (isTrainee(newUser)) enrollInHandstand(newUser.id, "admin-panel");
        syncDefaultGroups();
        // Someone created straight from Admin Panel never went through
        // signup, so they'd otherwise have no App sheet row at all and
        // wouldn't show on the Strength Ninjas map. Add one now, TYPE
        // already set from their assigned role.
        upsertAppSheetRow({ first, last, email: newUser.email, phone, role }).catch(e => console.error("[APP sheet sync]", e.message));
        ensureStudentLevelsRow(newUser).catch(e => console.error("[levels row]", e.message));
        // Admin creating someone else's account — no session cookie set here,
        // unlike signup. They'll get their own session when they log in.
        return sendJson(res, 200, { ok: true, user: publicUser(newUser) });
      }
    }
    const roleMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
    if (roleMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { role } = await readJsonBody(req);
      if (["user", "trainee", "online", "gym", "coach", "admin", "admin2"].indexOf(role) === -1) return sendJson(res, 400, { error: "role must be 'user', 'trainee', 'online', 'gym', 'coach', 'admin', or 'admin2'" });
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
      if (!isStaff(target)) pullFromStaffOnlyChats(target.id, users);
      if (isTrainee(target)) enrollInHandstand(target.id, "admin-panel");
      syncDefaultGroups();
      syncAppSheetRole(target).catch(e => console.error("[APP sheet role sync]", e.message)); ensureStudentLevelsRow(target).catch(e => console.error("[levels row]", e.message));
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
    // Per-coach on/off switch for the sidebar/thread-header "#/20" content
    // quota badge (see chat.html's coachQuotaBadgeHtml) -- an admin call,
    // not a coach setting on themselves, so a coach can't just turn their
    // own quota tracking off.
    const coachQuotaMatch = p.match(/^\/api\/admin\/users\/([^/]+)\/coach-quota-badge$/);
    if (coachQuotaMatch && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { enabled } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === coachQuotaMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      target.showCoachQuota = !!enabled;
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, user: publicUser(target) });
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

      MessagesDB.deleteMessagesForUserRemoval(dmIdsToRemove, targetId);

      return sendJson(res, 200, { ok: true });
    }
    // ── Purchases + refund for one account (Admin Panel long-press) ─────
    if (p === "/api/admin/user-purchases" && req.method === "GET") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const u = readJson(USERS_FILE, []).find(x => x.id === url.searchParams.get("userId"));
      if (!u) return sendJson(res, 404, { error: "User not found" });
      try {
        const r = await crmFetch(`/api/hc/bridge/orders?appUserId=${encodeURIComponent(u.id)}&email=${encodeURIComponent(u.email || "")}`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return sendJson(res, 502, { error: d.error || `CRM returned ${r.status}` });
        return sendJson(res, 200, { orders: d.orders || [], refundedAt: u.hcRefundedAt || null });
      } catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    if (p === "/api/admin/trainee-refund" && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const body = await readJsonBody(req);
      const u = readJson(USERS_FILE, []).find(x => x.id === String(body.userId || ""));
      if (!u) return sendJson(res, 404, { error: "User not found" });
      try {
        const r = await crmFetch("/api/hc/bridge/refund", { method: "POST", body: JSON.stringify({ appUserId: u.id, email: u.email || "", orderId: body.orderId || "", by: `${user.first || ""} ${user.last || ""}`.trim() || "PRA app" }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) return sendJson(res, 400, { error: d.error || `CRM returned ${r.status}` });
        const local = revokeHandstand(u.id, "refund", productOf(d.order?.sku) || "hc21");
        return sendJson(res, 200, { ok: true, order: d.order, account: local });
      } catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    // ── User Management tab (admin panel) ───────────────────────────────
    if (p === "/api/admin/user-management") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const BOOL_KEYS = ["signupEnabled", "forgotPasswordEnabled", "studentCrosscheckEnabled", "studentCrosscheckCrm", "studentGroupEnabled", "autoBuildProtocolEnabled",
        "levelsRowOnNewStudent", "appSheetTypeEnabled", "staffAlertsEnabled", "defaultProtocolEnabled", "welcomeMessageEnabled", "movesPublicDefault",
        "renewalMessageEnabled", "renewalPillsStaff", "holdPillsStaff", "renewalStudentNotice", "crmFinishedSync", "crmBlacklistArchive",
        "traineeWelcomeEnabled", "traineeRefundMakeUser"];
      const NUM_KEYS = { loginSessionDays: [1, 365, 30], resetLinkMinutes: [5, 1440, 60], minPasswordLength: [4, 64, 8], renewalMessageDaysBefore: [1, 90, 14] };
      const STR_KEYS = ["welcomeMessageText", "renewalMessageText", "renewalMessageSenderId", "renewalStudentText", "traineeWelcomeText",
        "appSheetId", "appSheetTab", "levelsSheetId", "crosscheckOnlineTab", "crosscheckGymTab", "crosscheckBlacklistTab"];
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const cfg = getConfig();
        for (const k of BOOL_KEYS) if (body[k] !== undefined) cfg[k] = !!body[k];
        for (const [k, [lo, hi, def]] of Object.entries(NUM_KEYS)) if (body[k] !== undefined) cfg[k] = Math.max(lo, Math.min(hi, Number(body[k]) || def));
        for (const k of STR_KEYS) if (body[k] !== undefined) cfg[k] = String(body[k]);
        if (body.traineeWelcomeByProduct && typeof body.traineeWelcomeByProduct === "object") {
          cfg.traineeWelcomeByProduct = { ...(cfg.traineeWelcomeByProduct || {}) };
          for (const [sku, t] of Object.entries(body.traineeWelcomeByProduct)) if (PRODUCTS[sku]) cfg.traineeWelcomeByProduct[sku] = String(t || "").slice(0, 4000);
        }
        if (body.access && typeof body.access === "object") cfg.access = mergeAccessDefaults({ ...cfg.access, ...Object.fromEntries(Object.entries(body.access).map(([r, v]) => [r, { ...(cfg.access?.[r] || {}), ...v }])) });
        writeJson(CONFIG_FILE, cfg);
        // Sheet changes take effect on the next read, not after a 10-minute cache.
        if (["appSheetId", "appSheetTab", "levelsSheetId", "crosscheckOnlineTab", "crosscheckGymTab", "crosscheckBlacklistTab"].some(k => body[k] !== undefined)) {
          levelsCache = null; studentEligibilityCache = null;
        }
      }
      const cfg = getConfig();
      const users = readJson(USERS_FILE, []);
      const settings = Object.fromEntries([...BOOL_KEYS, ...Object.keys(NUM_KEYS), ...STR_KEYS].map(k => [k, cfg[k]]));
      settings.access = cfg.access;
      settings.traineeWelcomeByProduct = cfg.traineeWelcomeByProduct || {};
      const staff = users.filter(u => isStaff(u) && !u.archived).map(u => ({ id: u.id, name: `${u.first} ${u.last}`, role: u.role }));
      const counts = {
        online: users.filter(u => u.role === "online" && !u.archived).length,
        gym: users.filter(u => u.role === "gym" && !u.archived).length,
        users: users.filter(u => u.role === "user" && !u.archived).length,
        trainees: users.filter(u => u.role === "trainee" && !u.archived).length,
        archived: users.filter(u => u.archived).length,
      };
      const draft = readJson(TRAINING_PROTOCOLS_FILE, {})[BUILDER_PROTOCOL_ID];
      const defaultProtocol = { name: draft?.protocolName || "(unnamed draft)", steps: (draft?.steps || []).length, videos: (draft?.steps || []).filter(x => x.type === "video").length, days: (draft?.steps || []).filter(x => x.type === "day").length };
      const sheets = {
        app: { id: appSheetId(), tab: appSheetTab(), isDefault: !extractSheetId(cfg.appSheetId) },
        levels: { id: levelsSheetId(), isDefault: !extractSheetId(cfg.levelsSheetId) },
        crosscheck: crosscheckTabs(),
      };
      const noMedia = users.filter(u => u.noMedia && !u.archived).map(u => ({ id: u.id, name: `${u.first} ${u.last}`, role: u.role }));
      const noMediaPending = Object.keys(readJson(NO_MEDIA_FILE, { pending: {} }).pending || {}).length;
      return sendJson(res, 200, { settings, staff, counts, defaultProtocol, sheets, noMedia, noMediaPending, accessFeatures: ACCESS_FEATURES, accessRoles: ACCESS_ROLES,
        defaultRenewalMessage: DEFAULT_RENEWAL_MESSAGE, defaultTraineeWelcome: DEFAULT_TRAINEE_WELCOME });
    }
    // Products sold in the CRM (Products tab), what a purchase does there, and
    // which app program each one gives the buyer.
    if (p === "/api/admin/products") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const cfg = getConfig();
      if (req.method === "POST") {
        const { sku, templateId } = await readJsonBody(req);
        if (!sku) return sendJson(res, 400, { error: "sku required" });
        cfg.productPrograms = { ...(cfg.productPrograms || {}), [String(sku)]: String(templateId || "") };
        writeJson(CONFIG_FILE, cfg);
      }
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const programs = templates.filter(t => t.kind === "program").map(t => ({ id: t.id, name: t.name, days: (t.steps || []).filter(s => s.type === "day").length, addOns: Object.keys(t.bumps || {}) }));
      let crm = null, crmError = null;
      try {
        const r = await crmFetch("/api/hc/bridge/products");
        crm = r.ok ? await r.json() : null;
        if (!r.ok) crmError = `CRM answered ${r.status}`;
      } catch (e) { crmError = e.message; }
      const products = (crm?.products || [{ sku: "hc21", name: HANDSTAND_TEMPLATE_NAME, price: null, bumps: [] }]).map(pr => {
        const mapped = getConfig().productPrograms?.[pr.sku];
        const def = PRODUCTS[pr.sku] ? findProductTemplate(templates, pr.sku) : null;
        return { ...pr, programId: (mapped && templates.some(t => t.id === mapped)) ? mapped : (def?.id || "") };
      });
      const users = readJson(USERS_FILE, []);
      return sendJson(res, 200, { products, programs, crmError, buyers: users.filter(u => isTrainee(u) && !u.archived).length });
    }

    // Spreadsheet name + tab links, so settings show "1. EMAIL LISTS > GYM" not an id.
    if (p === "/api/admin/sheet-info" && req.method === "GET") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const id = extractSheetId(url.searchParams.get("id"));
      if (!id) return sendJson(res, 400, { error: "Not a Google Sheet link" });
      try {
        const accessToken = await getGoogleAccessToken();
        const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties(title,sheetId)`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const d = await r.json();
        if (!r.ok) return sendJson(res, 200, { id, ok: false, error: d.error?.message || "Can't open that sheet" });
        return sendJson(res, 200, { id, ok: true, title: d.properties?.title || id, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, tabs: (d.sheets || []).map(x => ({ title: x.properties.title, gid: x.properties.sheetId })) });
      } catch (e) {
        return sendJson(res, 200, { id, ok: false, error: e.message });
      }
    }
    // Run auto-build by hand for one student (from a banner/User Management).
    if (p === "/api/admin/auto-build-protocol" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { userId } = await readJsonBody(req);
      const target = readJson(USERS_FILE, []).find(u => u.id === userId);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      try {
        return sendJson(res, 200, await autoBuildProtocolFromCustomPage(target, { force: true }));
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
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
        const { profilePhotosFolderId, chatImagesFolderId, chatVideosFolderId, trainingProtocolFolderId, trainingProtocolVideoLibraryFolderId, powerbaticsVideosFolderId, favoritesFolderId, intakeFormsFolderId, clientNotesFolderId, callRecordingsFolderId, bodyScanPhotosFolderId, nutritionPhotosFolderId, gymTrainingChannelId, gymTrainingFolderId, gymLevelTestChannelId, gymLevelTestFolderId, onlineLevelTestChannelId, physiqueMontageFolderId, gifApiKey, welcomeMessageEnabled, welcomeMessageText, callSummaryEnabled, callSummaryPrompt, dailyCheckinEnabled, dailyCheckinPrompt, dailyCheckinTime, dailyCheckinTimezone, dailyCheckinFrequencyValue, dailyCheckinFrequencyUnit, dailyCheckinSenderId, dailyCheckinQuietValue, dailyCheckinQuietUnit, dailyCheckinRule, appointments, movesPublicDefault, callSummaryMinMinutes } = await readJsonBody(req);
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
        if (gymTrainingChannelId !== undefined) cfg.gymTrainingChannelId = gymTrainingChannelId;
        if (gymTrainingFolderId !== undefined) cfg.gymTrainingFolderId = gymTrainingFolderId;
        if (gymLevelTestChannelId !== undefined) cfg.gymLevelTestChannelId = gymLevelTestChannelId;
        if (gymLevelTestFolderId !== undefined) cfg.gymLevelTestFolderId = gymLevelTestFolderId;
        if (onlineLevelTestChannelId !== undefined) cfg.onlineLevelTestChannelId = onlineLevelTestChannelId;
        if (physiqueMontageFolderId !== undefined) cfg.physiqueMontageFolderId = physiqueMontageFolderId;
        if (gifApiKey !== undefined) cfg.gifApiKey = gifApiKey;
        if (welcomeMessageEnabled !== undefined) cfg.welcomeMessageEnabled = !!welcomeMessageEnabled;
        if (welcomeMessageText !== undefined) cfg.welcomeMessageText = welcomeMessageText;
        if (callSummaryEnabled !== undefined) cfg.callSummaryEnabled = !!callSummaryEnabled;
        if (movesPublicDefault !== undefined) cfg.movesPublicDefault = !!movesPublicDefault;
        if (callSummaryMinMinutes !== undefined && Number.isFinite(Number(callSummaryMinMinutes))) cfg.callSummaryMinMinutes = Math.max(0, Number(callSummaryMinMinutes));
        if (callSummaryPrompt !== undefined) cfg.callSummaryPrompt = callSummaryPrompt;
        if (dailyCheckinEnabled !== undefined) cfg.dailyCheckinEnabled = !!dailyCheckinEnabled;
        if (dailyCheckinPrompt !== undefined) cfg.dailyCheckinPrompt = dailyCheckinPrompt;
        if (dailyCheckinTime !== undefined) cfg.dailyCheckinTime = dailyCheckinTime;
        if (dailyCheckinTimezone !== undefined) cfg.dailyCheckinTimezone = dailyCheckinTimezone;
        if (dailyCheckinFrequencyValue !== undefined) cfg.dailyCheckinFrequencyValue = Math.max(1, Number(dailyCheckinFrequencyValue) || 1);
        if (dailyCheckinQuietValue !== undefined) cfg.dailyCheckinQuietValue = Math.max(0, Number(dailyCheckinQuietValue) || 0);
        if (dailyCheckinQuietUnit !== undefined) cfg.dailyCheckinQuietUnit = dailyCheckinQuietUnit === "hours" ? "hours" : "days";
        if (dailyCheckinRule !== undefined) cfg.dailyCheckinRule = String(dailyCheckinRule);
        if (dailyCheckinFrequencyUnit !== undefined) cfg.dailyCheckinFrequencyUnit = dailyCheckinFrequencyUnit;
        if (dailyCheckinSenderId !== undefined) cfg.dailyCheckinSenderId = dailyCheckinSenderId;
        if (appointments !== undefined) cfg.appointments = { ...DEFAULT_APPOINTMENTS_CONFIG, ...cfg.appointments, ...appointments };
        saveConfig(cfg);
        return sendJson(res, 200, { ok: true });
      }
    }

    // One-time (repeatable) catch-up for groups that existed before the
    // welcome-message feature, or were somehow never sent one — anything
    // with zero messages at all gets it now. Ongoing new-group sends happen
    // automatically in syncDefaultGroups(); this is just for the backlog,
    // triggered by hand from the admin panel so it never fires on its own.
    if (p === "/api/admin/backfill-welcome-message" && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const cfg = getConfig();
      if (!cfg.welcomeMessageText) return sendJson(res, 400, { error: "Set a welcome message first." });
      const convos = readJson(CONVOS_FILE, []);
      const groupConvos = convos.filter(c => c.type === "group" && c.autoGroupType === "student");
      const lastMsgs = MessagesDB.getLastMessages(groupConvos.map(c => c.id));
      const emptyGroups = groupConvos.filter(c => !lastMsgs.has(c.id));
      const users = readJson(USERS_FILE, []);
      let sent = 0;
      for (const convo of emptyGroups) {
        const student = users.find(u => u.id === convo.autoGroupUserId);
        // Prefer an admin participant as the sender (same convention as
        // syncDefaultGroups' own send); fall back to whoever's in the group
        // on the rare chance an auto-group somehow has no staff in it.
        const senderId = convo.participantIds.find(id => isAdmin(users.find(u => u.id === id) || {})) || convo.participantIds[0];
        if (!senderId) continue;
        const text = fillTemplate(cfg.welcomeMessageText, { firstName: student?.first || "", lastName: student?.last || "", userId: student?.id || "" });
        MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "text", text, createdAt: new Date().toISOString() });
        notifyParticipants(convo.id, senderId, { title: "New message", body: pushText(text).slice(0, 120), conversationId: convo.id }).catch(() => {});
        sent++;
      }
      return sendJson(res, 200, { ok: true, sent, totalEmptyGroups: emptyGroups.length });
    }

    // Every group/channel conversation, for the admin panel's Gym Training /
    // Gym Level Test channel picker -- system-wide, not scoped to the
    // requesting admin's own participant list, since this is "pick which
    // channel the feature targets," not "conversations I'm in."
    if (p === "/api/admin/groups" && req.method === "GET") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const groups = readJson(CONVOS_FILE, []).filter(c => c.type === "group")
        .map(c => ({ id: c.id, name: c.name || "Untitled group", isChannel: !!c.isChannel }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, { groups });
    }

    // ─── Gym schedule: dates blocked off from booking ──────────────────────
    // Global, not per-student — the Gym's 2 fixed daily slots are a shared
    // facility resource, so blocking a date (holiday, gym closure, etc.)
    // blocks it for every Gym client's booking, not just one person's.
    if (p === "/api/chat/gym-blocked-dates" && req.method === "GET") {
      // `dates` = whole days blocked (unchanged shape); `slots` = individual
      // time slots blocked on otherwise-open days.
      return sendJson(res, 200, getGymAvailability());
    }
    // The admin availability editor saves both kinds at once. Past dates are
    // dropped on the way in -- they can't matter anymore and would otherwise
    // pile up forever.
    if (p === "/api/admin/gym-availability" && req.method === "POST") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const { dates, slots } = await readJsonBody(req);
      const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
      if (!Array.isArray(dates) || !dates.every(isDate)) return sendJson(res, 400, { error: "dates must be an array of 'YYYY-MM-DD' strings" });
      if (!slots || typeof slots !== "object" || Array.isArray(slots)
        || !Object.entries(slots).every(([d, arr]) => isDate(d) && Array.isArray(arr) && arr.every(s => GYM_SLOTS[s]))) {
        return sendJson(res, 400, { error: "slots must map 'YYYY-MM-DD' to arrays of slot ids" });
      }
      const today = todayInZone(GYM_TZ);
      writeJson(GYM_BLOCKED_DATES_FILE, Array.from(new Set(dates.filter(d => d >= today))).sort());
      const cleanSlots = {};
      for (const [d, arr] of Object.entries(slots)) {
        if (d >= today && arr.length) cleanSlots[d] = Array.from(new Set(arr)).sort();
      }
      writeJson(GYM_BLOCKED_SLOTS_FILE, cleanSlots);
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
    // ─── Quick Start ─────────────────────────────────────────────────────
    if (p === "/api/chat/quickstart" && req.method === "GET") {
      const qs = qsRead();
      const cfg = qs.config;
      if (!qsEligible(cfg, user)) return sendJson(res, 200, { enabled: false });
      const now = Date.now();
      const rec = qs.users[user.id] || {};
      let changed = false;
      if (!rec.firstSeenAt) { rec.firstSeenAt = now; rec.showUntil = now + cfg.buttonFirstDays * QS_DAY; changed = true; }
      else if (rec.lastSeenAt && now - rec.lastSeenAt >= cfg.awayDays * QS_DAY) {
        rec.showUntil = Math.max(rec.showUntil || 0, now + cfg.comebackDays * QS_DAY); changed = true;
      }
      // Last-seen is only written every 30 min (this runs on every page).
      if (changed || !rec.lastSeenAt || now - rec.lastSeenAt > 30 * 60 * 1000) { rec.lastSeenAt = now; changed = true; }
      if (changed) { qs.users[user.id] = rec; writeJson(QS_FILE, qs); }
      const tester = (cfg.testers || []).includes(user.id);
      const completed = !!rec.completedAt;
      return sendJson(res, 200, {
        enabled: true, tester, completed, autoStart: !!cfg.autoStart && !completed,
        forceStart: !!cfg.autoStart && !completed && now - rec.firstSeenAt < (Number(cfg.forceStartDays) || 0) * QS_DAY,
        showButton: completed && (now < (rec.showUntil || 0) || (tester && cfg.testersAlwaysButton)),
        texts: cfg.texts || {}, steps: cfg.steps || null, hidePromo: !!cfg.hidePromoUntilDone,
      });
    }
    if (p === "/api/chat/quickstart/complete" && req.method === "POST") {
      const qs = qsRead();
      const rec = qs.users[user.id] || { firstSeenAt: Date.now(), showUntil: Date.now() + qs.config.buttonFirstDays * QS_DAY };
      rec.completedAt = Date.now(); rec.completions = (rec.completions || 0) + 1;
      // Admin Panel's finish message: posted once, the first time they
      // finish, into their own group, from the chosen staff member (if
      // they're in that group) or else the first coach/admin in it.
      const fm = qs.config.finishMessage || {};
      const fmText = String(fm.text || "").trim();
      if (fmText && !rec.finishMessageSentAt) {
        try {
          const convo = readJson(CONVOS_FILE, []).find(c => c.autoGroupType === "student" && c.autoGroupUserId === user.id);
          if (convo) {
            const users = readJson(USERS_FILE, []);
            const staffIds = users.filter(u => isStaff(u) && !u.archived).map(u => u.id);
            const senderId = (fm.senderId && convo.participantIds.includes(fm.senderId) && staffIds.includes(fm.senderId) ? fm.senderId : null)
              || convo.participantIds.find(id => staffIds.includes(id));
            if (senderId) {
              const text = fmText.replace(/\{first\}/gi, user.first || "").replace(/\{name\}/gi, `${user.first || ""} ${user.last || ""}`.trim());
              MessagesDB.insertMessage({ id: randomUUID(), conversationId: convo.id, senderId, type: "text", text, createdAt: new Date().toISOString() });
              notifyParticipants(convo.id, senderId, { title: "New message", body: text.slice(0, 120), conversationId: convo.id }).catch(() => {});
              rec.finishMessageSentAt = Date.now();
            }
          }
        } catch (e) { console.error("[quickstart] finish message", e.message); }
      }
      qs.users[user.id] = rec; writeJson(QS_FILE, qs);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/admin/quickstart") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      const qs = qsRead();
      if (req.method === "POST") {
        const b = await readJsonBody(req);
        const c = qs.config;
        if (["off", "testers", "everyone"].includes(b.enabledFor)) c.enabledFor = b.enabledFor;
        if (Array.isArray(b.testers)) c.testers = b.testers.map(String).slice(0, 50);
        if (Array.isArray(b.roles)) c.roles = b.roles.filter(r => ["user", "trainee", "online", "gym", "coach", "admin", "admin2"].includes(r));
        for (const k of ["autoStart", "testersAlwaysButton", "hidePromoUntilDone"]) if (b[k] !== undefined) c[k] = !!b[k];
        for (const k of ["buttonFirstDays", "awayDays", "comebackDays", "forceStartDays"]) if (b[k] !== undefined) c[k] = Math.max(0, Math.min(60, Number(b[k]) || 0));
        if (b.texts && typeof b.texts === "object") {
          const t = {};
          for (const [k, v] of Object.entries(b.texts)) {
            if (!/^\d+\.\d+$/.test(k) || !v) continue;
            const title = String(v.title || "").slice(0, 80), text = String(v.text || "").slice(0, 300);
            if (title || text) t[k] = { title, text };
          }
          c.texts = t;
        }
        if (b.steps !== undefined) c.steps = b.steps === null ? null : qsCleanSteps(b.steps);
        if (b.finishMessage && typeof b.finishMessage === "object") c.finishMessage = { text: String(b.finishMessage.text || "").slice(0, 1000), senderId: String(b.finishMessage.senderId || "").slice(0, 80) };
        if (b.resetUserId) { const r = qs.users[String(b.resetUserId)]; if (r) { delete r.completedAt; } }
        qs.config = c; writeJson(QS_FILE, qs);
      }
      const users = readJson(USERS_FILE, []);
      const byId = new Map(users.map(u => [u.id, u]));
      const people = Object.entries(qs.users).map(([id, r]) => {
        const u = byId.get(id);
        return { id, name: u ? `${u.first} ${u.last}` : id, role: u?.role || "", completedAt: r.completedAt || null, completions: r.completions || 0, firstSeenAt: r.firstSeenAt || null, lastSeenAt: r.lastSeenAt || null, showUntil: r.showUntil || null };
      }).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
      const staffAndAll = users.filter(u => !u.archived).map(u => ({ id: u.id, name: `${u.first} ${u.last}`, role: u.role })).sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, { config: qs.config, people, users: staffAndAll });
    }

    if (p === "/api/chat/contacts" && req.method === "GET") {
      // Everyone shows up in everyone's directory now — visibility here is
      // just "who exists," not "who can be messaged." canCreateDm() is the
      // actual gate on starting a new DM: a plain user/online/gym viewer
      // can still only reach admin/admin2 that way. Clicking any other
      // contact from this list instead opens a read-only profile popup
      // (see openContactProfile() in chat.html) — the shared auto-group
      // (syncDefaultGroups) plus whatever an admin starts with them
      // directly remain the only real conversations a client ever has.
      let users = readJson(USERS_FILE, []).filter(u => u.id !== user.id && !u.archived);
      // Trainees see the same directory as students (clicking a row only
      // opens that person's profile panel); nobody but staff sees trainees.
      if (!isStaff(user)) users = users.filter(u => !isTrainee(u));
      // Staff also get each student's renewal alert (see renewalForStudent) so a student's own
      // row -- often with no conversation yet -- is flagged like their coaching group.
      let renewalEligibility = null;
      if (isStaff(user)) { try { renewalEligibility = await fetchStudentEligibility(); } catch { renewalEligibility = null; } }
      let holds = null;
      if (isStaff(user)) { try { holds = await crmOnHoldContacts(); } catch { holds = null; } }
      return sendJson(res, 200, { contacts: users.map(u => {
        const rn = renewalForStudent(u, user, renewalEligibility);
        const hd = holdForStudent(u, user, holds);
        const base = rn ? { ...publicUser(u), renewal: { level: rn.level, endDate: rn.endDate, unhandled: rn.unhandled } } : publicUser(u);
        return hd ? { ...base, hold: hd } : base;
      }) });
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
        const idByName = new Map(readJson(USERS_FILE, []).filter(u => !u.archived).map(u => [nameKey(u.first, u.last), u.id]));
        points.forEach(pt => { pt.userId = idByName.get(nameKey(pt.first, pt.last)) || null; });
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
    // ── Coach content quota, current calendar month ("favorited + gym-cammed
    // this month / goal") ── Every staff member's count, not just the
    // caller's own — the point of the badge is coaches seeing everyone's
    // pace, same list a shared group's member row already shows.
    if (p === "/api/chat/coach-monthly-stats" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
      // Plain ISO string comparison is valid here -- every createdAt in this
      // app comes from the same toISOString() format, so lexicographic order
      // matches chronological order without parsing each one.
      const inMonth = (iso) => iso && iso >= monthStart && iso < nextMonthStart;
      const counts = {};
      const bump = (userId) => { if (userId) counts[userId] = (counts[userId] || 0) + 1; };

      readJson(FAVORITES_FILE, []).forEach(f => { if (inMonth(f.createdAt)) bump(f.userId); });

      // "Gym-cammed" = a video posted into one of the two Gym Capture
      // channels -- there's no separate flag on the message itself (the
      // gym-capture endpoint just posts a normal video message), so this is
      // the same proxy that channel's own history already represents.
      const cfg = getConfig();
      const gymChannelIds = new Set([cfg.gymTrainingChannelId, cfg.gymLevelTestChannelId].filter(Boolean));
      if (gymChannelIds.size) {
        MessagesDB.getVideosInMonth([...gymChannelIds], monthStart, nextMonthStart).forEach(m => bump(m.senderId));
      }

      return sendJson(res, 200, { counts, goal: 20 });
    }

    if (p === "/api/chat/favorites" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const all = readJson(FAVORITES_FILE, []);
      const conversationId = url.searchParams.get("conversationId");
      let mine = all.filter(f => f.userId === user.id);
      if (conversationId) mine = mine.filter(f => f.conversationId === conversationId);
      mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJson(res, 200, { favorites: mine });
    }

    // Any logged-in user's own view of "videos favorited about me" -- every
    // video a coach has starred in a conversation this user participates in
    // (not staff-gated like the route above, which is a coach's own list of
    // what THEY starred; this is the reverse view, for the Physique
    // Builder's Moves tab). No new Drive folder/proxy needed -- favorites
    // already carry a Drive webViewLink from when they were saved.
    if (p === "/api/chat/my-favorited-videos" && req.method === "GET") {
      const convos = readJson(CONVOS_FILE, []);
      const mine = readJson(FAVORITES_FILE, []).filter(f => {
        if (f.type !== "video") return false;
        const convo = convos.find(c => c.id === f.conversationId);
        return convo && convo.participantIds.includes(user.id);
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
      const srcMsg = MessagesDB.findMessageByDriveFileId(driveFileId, { typesIn: ["image", "video"] });
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

    // ─── Gym Capture (coach/admin header camera icon) ──────────────────────
    // Not tied to an open conversation -- a fresh recording, trimmed and
    // labeled client-side (same shoot/trim flow as the in-chat camera),
    // lands in whichever admin-configured Gym Training / Gym Level Test
    // channel the coach picked, and a copy is saved to that category's
    // Drive folder under the typed label.
    if (p === "/api/chat/gym-capture" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const ct = req.headers["content-type"] || "";
      if (!ct.startsWith("multipart/form-data")) return sendJson(res, 400, { error: "video is required" });

      const cfg = getConfig();
      let label = "", destination = "", trimStart, trimEnd;
      let uploadPromise = null;
      await new Promise((resolve, reject) => {
        const bb = Busboy({ headers: req.headers, limits: { fieldSize: 5 * 1024 * 1024 } });
        // Client appends label/destination/trim fields before the video file
        // (same FormData-order-is-parse-order convention the in-chat camera
        // upload already relies on) -- set by the time the file event fires.
        bb.on("field", (name, val) => {
          if (name === "label") label = val;
          if (name === "destination") destination = val;
          if (name === "trimStart") trimStart = Number(val);
          if (name === "trimEnd") trimEnd = Number(val);
        });
        bb.on("file", (name, stream, info) => {
          const ext = extFromMime(info.mimeType, info.filename);
          const tempPath = join(tmpdir(), `gym-capture-${randomUUID()}${ext}`);
          let trimmedPath = null;
          uploadPromise = (async () => {
            try {
              await new Promise((res, rej) => {
                const ws = createWriteStream(tempPath);
                stream.pipe(ws);
                ws.on("finish", res);
                ws.on("error", rej);
                stream.on("error", rej);
              });
              let sourcePath = tempPath;
              if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
                trimmedPath = tempPath + "-trimmed.mp4";
                try {
                  trimVideo(tempPath, trimmedPath, trimStart, trimEnd);
                  sourcePath = trimmedPath;
                } catch (e) {
                  console.error("[gym-capture] trim failed:", e.message);
                  trimmedPath = null;
                }
              }
              const outExt = sourcePath === trimmedPath ? ".mp4" : ext;
              const outMimeType = sourcePath === trimmedPath ? "video/mp4" : info.mimeType;
              const folderId = destination === "levelTest" ? cfg.gymLevelTestFolderId : cfg.gymTrainingFolderId;
              const baseName = (label || "GYM CLIP").trim().toUpperCase();
              const accessToken = await getDriveAccessToken();
              const result = await uploadStreamToDrive(createReadStream(sourcePath), {
                name: baseName + outExt, mimeType: outMimeType, folderId, accessToken,
              });
              return { driveFileId: result.id, mimeType: outMimeType, name: info.filename, driveFileName: baseName };
            } finally {
              try { unlinkSync(tempPath); } catch {}
              if (trimmedPath) { try { unlinkSync(trimmedPath); } catch {} }
            }
          })();
        });
        bb.on("finish", resolve);
        bb.on("error", reject);
        req.pipe(bb);
      });

      if (destination !== "training" && destination !== "levelTest") return sendJson(res, 400, { error: "destination must be 'training' or 'levelTest'" });
      const channelId = destination === "levelTest" ? cfg.gymLevelTestChannelId : cfg.gymTrainingChannelId;
      const folderId = destination === "levelTest" ? cfg.gymLevelTestFolderId : cfg.gymTrainingFolderId;
      const destLabel = destination === "levelTest" ? "Gym Level Test" : "Gym Training";
      if (!channelId || !folderId) return sendJson(res, 400, { error: `${destLabel} isn't set up yet — ask an admin to assign its channel and Drive folder in Admin Settings.` });
      const convos = readJson(CONVOS_FILE, []);
      const convo = convos.find(c => c.id === channelId);
      if (!convo) return sendJson(res, 400, { error: `The ${destLabel} channel no longer exists — ask an admin to reassign it in Admin Settings.` });

      if (!uploadPromise) return sendJson(res, 400, { error: "video is required" });
      let uploaded;
      try {
        uploaded = await uploadPromise;
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }

      // Posting into a channel you capture for is a reasonable implicit
      // join -- otherwise the coach who just sent it couldn't see it land
      // (the sidebar/thread list are both scoped to participantIds).
      if (!convo.participantIds.includes(user.id)) {
        convo.participantIds.push(user.id);
        writeJson(CONVOS_FILE, convos);
      }
      const msg = {
        id: randomUUID(), conversationId: convo.id, senderId: user.id,
        type: "video", driveFileId: uploaded.driveFileId, mimeType: uploaded.mimeType, name: uploaded.name,
        driveFileName: uploaded.driveFileName,
        createdAt: new Date().toISOString(),
      };
      MessagesDB.insertMessage(msg);
      logActivity(user.id, "video_favorited", `Sent a gym capture video: ${label}`, { conversationId: convo.id });
      return sendJson(res, 200, { ok: true, conversationId: convo.id, message: msg });
    }

    // ─── Online Level Test forward (message action bar, video only) ────────
    // Forwards an already-sent video into the admin-configured Online Level
    // Tests channel, with an optional coach note posted right after it (so
    // it reads as a caption underneath, same as any other video+text pair
    // in a normal thread) -- no fresh upload, the video's already in Drive.
    if (p === "/api/chat/level-test-forward" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const { messageId, note } = await readJsonBody(req);
      if (!messageId) return sendJson(res, 400, { error: "messageId is required" });
      const srcMsg = MessagesDB.getMessageById(messageId);
      if (!srcMsg || srcMsg.type !== "video") return sendJson(res, 404, { error: "Video message not found" });
      const convos = readJson(CONVOS_FILE, []);
      const srcConvo = convos.find(c => c.id === srcMsg.conversationId);
      if (!srcConvo || !srcConvo.participantIds.includes(user.id)) return sendJson(res, 403, { error: "Not a participant in that conversation" });

      const cfg = getConfig();
      if (!cfg.onlineLevelTestChannelId) return sendJson(res, 400, { error: "Online Level Tests channel isn't set up yet — ask an admin to assign it in Admin Settings." });
      const targetConvo = convos.find(c => c.id === cfg.onlineLevelTestChannelId);
      if (!targetConvo) return sendJson(res, 400, { error: "The Online Level Tests channel no longer exists — ask an admin to reassign it in Admin Settings." });

      if (!targetConvo.participantIds.includes(user.id)) {
        targetConvo.participantIds.push(user.id);
        writeJson(CONVOS_FILE, convos);
      }
      const now = Date.now();
      const videoMsg = {
        id: randomUUID(), conversationId: targetConvo.id, senderId: user.id,
        type: "video", driveFileId: srcMsg.driveFileId, mimeType: srcMsg.mimeType, name: srcMsg.name,
        driveFileName: srcMsg.driveFileName, forwarded: true,
        createdAt: new Date(now).toISOString(),
      };
      const toInsert = [videoMsg];
      const trimmedNote = String(note || "").trim();
      if (trimmedNote) {
        toInsert.push({
          id: randomUUID(), conversationId: targetConvo.id, senderId: user.id,
          type: "text", text: trimmedNote,
          createdAt: new Date(now + 1).toISOString(),
        });
      }
      MessagesDB.insertMessages(toInsert);
      return sendJson(res, 200, { ok: true, conversationId: targetConvo.id });
    }

    // ─── Gym + Online skill levels (combined, searchable) ─────────────────
    // Levels are visible to any signed-in viewer, same as /api/chat/users-map
    // and /api/chat/levels/lookup — only `last` name stays staff-only (except
    // on your own entry), and only coaches/admins can edit (/levels/update).
    if (p === "/api/chat/levels" && req.method === "GET") {
      try {
        const people = await fetchAllLevels();
        const enriched = await enrichLevelsPeople(people);
        const idByName = new Map(readJson(USERS_FILE, []).filter(u => !u.archived).map(u => [nameKey(u.first, u.last), u.id]));
        enriched.forEach(pp => { pp.userId = idByName.get(nameKey(pp.first, pp.last)) || null; });
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
        const entries = levelsEntriesForUser(user, people);
        return sendJson(res, 200, { entries, categories: LEVELS_CATEGORIES });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Lookup by arbitrary name — used by the Users Map popup, chat's
    // contact-profile popup, and profile.html's "My Levels" section. Levels
    // are visible to any signed-in viewer for anyone now; only the write
    // side (/api/chat/levels/update below) stays staff-only.
    // Katas: the kata video for each level a person is at. Students see
    // their own; coaches/admins can pick any student (?userId=).
    if (p === "/api/chat/katas" && req.method === "GET") {
      const targetId = url.searchParams.get("userId") || user.id;
      if (targetId !== user.id && !isStaff(user)) return sendJson(res, 403, { error: "Not allowed" });
      if (targetId === user.id && !accessFor(user).katas) return sendJson(res, 200, { katas: [], hasLevels: false, locked: true });
      const target = readJson(USERS_FILE, []).find(u => u.id === targetId);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      try {
        const r = await katasForPerson(target.first, target.last);
        return sendJson(res, 200, { user: { id: target.id, first: target.first, last: target.last }, ...r });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    // Coach/admin "Student Katas" dropdown: every app student.
    if (p === "/api/chat/katas/students" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const students = readJson(USERS_FILE, []).filter(u => isClientRole(u.role))
        .map(u => ({ id: u.id, first: u.first, last: u.last, role: u.role }))
        .sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`));
      return sendJson(res, 200, { students });
    }
    if (p === "/api/chat/katas/refresh" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      await fetchKataLibrary(true);
      return sendJson(res, 200, { ok: true });
    }

    // Red banner for coaches/admins (chat-header.js): problems to fix.
    if (p === "/api/chat/staff-alerts" && req.method === "GET") {
      if (!isStaff(user) || !getConfig().staffAlertsEnabled) return sendJson(res, 200, { alerts: [] });
      const d = readStaffAlerts();
      let all = [...d.alerts];
      try { all = all.concat(await nameMismatchAlerts()); } catch (e) { console.error("[staff alerts] name check", e.message); }
      try { all = all.concat(noPushAlerts()); } catch (e) { console.error("[staff alerts] push check", e.message); }
      // adminOnly: video-call problems the person on the call can't fix themselves.
      return sendJson(res, 200, { alerts: all.filter(a => !d.dismissed[a.id] && (!a.adminOnly || isAdmin(user))) });
    }
    if (p === "/api/chat/staff-alerts/dismiss" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { id } = await readJsonBody(req);
      const d = readStaffAlerts();
      d.dismissed[String(id)] = { by: user.id, at: new Date().toISOString() };
      d.alerts = d.alerts.filter(a => a.id !== id);
      writeJson(STAFF_ALERTS_FILE, d);
      return sendJson(res, 200, { ok: true });
    }

    if (p === "/api/chat/levels/lookup" && req.method === "GET") {
      const qFirst = url.searchParams.get("first");
      const qLast = url.searchParams.get("last");
      try {
        const people = await fetchAllLevels();
        // ?userId= (chat profile popup): that account's levels, which for a
        // shared family/couple login is everyone on it (levelsPeopleForUser).
        const qUser = url.searchParams.get("userId") ? readJson(USERS_FILE, []).find(u => u.id === url.searchParams.get("userId")) : null;
        const entries = qUser ? levelsEntriesForUser(qUser, people) : findLevelsEntries(people, qFirst, qLast);
        return sendJson(res, 200, { entries, categories: LEVELS_CATEGORIES });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Coach/admin linking several people's Levels rows to one account (a
    // family or couple sharing a login). An empty list goes back to automatic
    // (CRM FAMILY MEMBERS / first-name split -- levelsPeopleForUser).
    const levelsLinksMatch = p.match(/^\/api\/chat\/users\/([^/]+)\/levels-links$/);
    if (levelsLinksMatch && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const { links } = await readJsonBody(req);
      const clean = (Array.isArray(links) ? links : []).map(m => ({ first: String(m?.first || "").trim(), last: String(m?.last || "").trim() })).filter(m => m.first && m.last);
      const users = readJson(USERS_FILE, []);
      const target = users.find(u => u.id === levelsLinksMatch[1]);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      if (clean.length) target.levelsLinks = clean; else delete target.levelsLinks;
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, links: target.levelsLinks || [] });
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
        const saved = await updateLevelsRow({ first, last, program, levels: levels || {}, team: !!team });
        levelUpsFromSave({ first, last, program, before: saved?.before, after: levels || {}, by: user.id }).catch(e => console.error("[level-up] trigger", e.message)); // -> CRM certificate flow
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Coach/admin fixing a name typo (or a legal-name change) right from the
    // Levels tab or a chat profile popup. `first`/`last` is the CURRENT name
    // (used to find the row(s) to rename, and — when `userId` isn't given —
    // to find a matching chat account); `newFirst`/`newLast` is what it
    // becomes. Renames on both the Levels sheet (whichever tabs have a
    // matching row) and the chat account, so the two stay in sync; does NOT
    // touch the separate App sheet's name-matched row (location/archetype
    // enrichment for this person will stop matching until that's fixed by
    // hand — same known gap as the admin panel's own /profile rename below).
    if (p === "/api/chat/people/rename" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const { first, last, newFirst, newLast, userId } = await readJsonBody(req);
      if (!first || !last) return sendJson(res, 400, { error: "Current first and last name are required" });
      const nf = String(newFirst || "").trim(), nl = String(newLast || "").trim();
      if (!nf || !nl) return sendJson(res, 400, { error: "New first and last name are required" });
      try {
        const sheetsUpdated = await renameLevelsRows({ first, last, newFirst: nf, newLast: nl });
        const users = readJson(USERS_FILE, []);
        const target = userId
          ? users.find(u => u.id === userId)
          : users.find(u => nameKey(u.first, u.last) === nameKey(first, last));
        let updatedUser = null;
        if (target) {
          target.first = nf;
          target.last = nl;
          writeJson(USERS_FILE, users);
          updatedUser = publicUser(target);
        }
        return sendJson(res, 200, { ok: true, sheetsUpdated, user: updatedUser });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Unlike /levels/update above (an edit-or-create upsert, used for an
    // existing person's own levels), this is specifically "add a brand new
    // student to the roster" -- it rejects outright if that name is already
    // on EITHER tab (not just the one being added to; a gym student showing
    // up as a second "new" online row, or vice versa, is still a duplicate
    // person) rather than silently overwriting them.
    if (p === "/api/chat/levels/add-student" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { first, last, program, levels, team } = await readJsonBody(req);
      if (!first || !String(first).trim() || !last || !String(last).trim()) return sendJson(res, 400, { error: "First and last name are required" });
      if (!["Gym", "Online"].includes(program)) return sendJson(res, 400, { error: "program must be 'Gym' or 'Online'" });
      try {
        const [inGym, inOnline] = await Promise.all([
          findLevelsRowByName("GYM", first, last),
          findLevelsRowByName("ONLINE", first, last),
        ]);
        if (inGym || inOnline) {
          return sendJson(res, 409, { error: `${first} ${last} is already on the ${inGym ? "Gym" : "Online"} levels sheet.` });
        }
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
    // ─── Program view (dripped course, e.g. the Handstand Protocol) ───────
    // The enrolled user (or staff) gets the template's live content split
    // into intro sections + days. Students only receive unlocked days plus
    // the next locked day's title/unlock time -- later days never leave the
    // server. Staff get everything with each day's drip state. Staff can
    // also preview a template directly (no enrollment, nothing locked).
    const programTemplatePreview = p.match(/^\/api\/chat\/protocol-program\/template\/([^/]+)$/);
    if (programTemplatePreview && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const template = readJson(PROTOCOL_TEMPLATES_FILE, []).find(t => t.id === programTemplatePreview[1]);
      if (!template) return sendJson(res, 404, { error: "Template not found" });
      return sendJson(res, 200, { program: buildProgramView(template, null, { staffView: true, ownedBumps: [] }) });
    }
    // Same view from the editor's unsaved draft (steps / settings / goal) -- nothing is saved.
    if (programTemplatePreview && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const template = readJson(PROTOCOL_TEMPLATES_FILE, []).find(t => t.id === programTemplatePreview[1]);
      if (!template) return sendJson(res, 404, { error: "Template not found" });
      const draft = await readJsonBody(req);
      let settings = template.settings;
      try { if (draft.settings) settings = sanitizeProgramSettings(draft.settings, template.settings); } catch {}
      const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
      const view = { ...template, settings, steps: Array.isArray(draft.steps) && draft.steps.length ? draft.steps : template.steps, goal: typeof draft.goal === "string" ? draft.goal : template.goal, bumps: isObj(draft.bumps) ? draft.bumps : template.bumps };
      return sendJson(res, 200, { program: buildProgramView(view, null, { staffView: true, ownedBumps: [] }) });
    }
    const programMatch = p.match(/^\/api\/chat\/protocol-program\/([^/]+)$/);
    if (programMatch && req.method === "GET") {
      const targetUserId = programMatch[1];
      if (targetUserId !== user.id && !isStaff(user)) return sendJson(res, 403, { error: "Not allowed" });
      const target = readJson(USERS_FILE, []).find(u => u.id === targetUserId);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const programs = readJson(TRAINING_PROTOCOLS_FILE, {})[targetUserId]?.programs || [];
      const wanted = url.searchParams.get("templateId");
      const enr = (wanted && programs.find(e => findProgramTemplate(templates, e)?.id === wanted)) || programs.find(e => findProgramTemplate(templates, e)) || null;
      const template = findProgramTemplate(templates, enr);
      if (!template) return sendJson(res, 404, { error: programs.length ? "This program isn't installed yet" : "Not enrolled in a program" });
      const staffView = isStaff(user) && user.id !== targetUserId;
      return sendJson(res, 200, { program: buildProgramView(template, enr, { staffView, ownedBumps: target.hcBumps || [] }), ownedBumps: target.hcBumps || [] });
    }

    const TRAINING_PROTOCOL_RESERVED_SUBPATHS = ["upload-image", "upload-video", "search-videos", "video-folders", "label-video", "ai-generate", "apply", "default-protocol", "video-error"];
    const protocolMatch = p.match(/^\/api\/chat\/training-protocol\/([^/]+)$/);
    if (protocolMatch && !TRAINING_PROTOCOL_RESERVED_SUBPATHS.includes(protocolMatch[1])) {
      const targetUserId = protocolMatch[1];
      const canView = user.id === targetUserId || isStaff(user);
      if (!canView) return sendJson(res, 403, { error: "Not allowed" });

      if (req.method === "GET") {
        const all = readJson(TRAINING_PROTOCOLS_FILE, {});
        // lastAiPrompt rides along with steps (same per-client record) so the
        // AI modal can reopen pre-filled with whatever was last used for
        // THIS client — see the ai-generate endpoint below, which is what
        // actually sets it. protocolName is only ever set by POST
        // /api/chat/training-protocol/apply below (a plain steps save never
        // touches it, see that POST handler's comment).
        return sendJson(res, 200, {
          steps: all[targetUserId]?.steps || [],
          lastAiPrompt: all[targetUserId]?.lastAiPrompt || "",
          protocolName: all[targetUserId]?.protocolName || "",
          // Which saved template (if any) this protocol was saved-as/
          // loaded-from -- see training-protocol.html's loadedTemplateId,
          // which this is what actually survives a page reload for. Without
          // persisting it here, the link only ever lived in that one page
          // load's own memory: renaming the title would sync the template
          // exactly once, then silently stop the moment the coach came back
          // to a fresh load of the same page, which is exactly what looked
          // like the sync "not working" even though it just ran that one
          // time already.
          templateId: all[targetUserId]?.templateId || null,
          // Enrolled programs (e.g. the Handstand Protocol) -- shown by
          // training-protocol.html's program view, steps read live from the
          // template via /api/chat/protocol-program/:userId.
          programs: (() => {
            const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
            return (all[targetUserId]?.programs || []).map(e => {
              const t = findProgramTemplate(templates, e);
              return { templateId: t?.id || e.templateId || null, name: t?.name || e.templateName || "", startedAt: e.startedAt || null, installed: !!t };
            });
          })(),
        });
      }
      if (req.method === "POST") {
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
        const { steps, name, templateId } = await readJsonBody(req);
        if (!Array.isArray(steps)) return sendJson(res, 400, { error: "steps must be an array" });
        const all = readJson(TRAINING_PROTOCOLS_FILE, {});
        // Merge, not replace — a plain step save (e.g. dragging a step
        // around) must never silently wipe out the saved AI prompt sitting
        // in this same per-client record. `name`/`templateId` are optional
        // and only touched when actually sent (the inline title editor
        // sends `name` on every save, Save/Load Template send `templateId`
        // once when establishing the link; every other caller of this same
        // endpoint -- drag-reorder, add/delete step, undo/redo -- never
        // includes either, so both ride along untouched exactly like
        // lastAiPrompt already does above).
        all[targetUserId] = {
          ...all[targetUserId], steps,
          ...(name !== undefined ? { protocolName: name } : {}),
          ...(templateId !== undefined ? { templateId } : {}),
          updatedAt: new Date().toISOString(), updatedBy: user.id,
        };
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
            // Every upload goes through remuxVideoForWeb now, even ones the
            // browser already labeled video/mp4 -- an iPhone can export an
            // already-.mp4 file that still carries the same yuvj420p quirk
            // remuxVideoForWeb's own comment explains, so checking the
            // declared MIME type alone isn't enough to know a given file is
            // actually safe everywhere.
            const ext = extFromMime(info.mimeType, fileName);
            const tempPath = join(tmpdir(), `protocol-video-${randomUUID()}${ext}`);
            const outPath = tempPath + "-web.mp4";
            uploadPromise = (async () => {
              try {
                await new Promise((res2, rej2) => {
                  const ws = createWriteStream(tempPath);
                  stream.pipe(ws);
                  ws.on("finish", res2);
                  ws.on("error", rej2);
                  stream.on("error", rej2);
                });
                remuxVideoForWeb(tempPath, outPath);
                const outName = fileName.replace(/\.[^.]+$/, "") + ".mp4";
                return await uploadStreamToDrive(createReadStream(outPath), {
                  name: outName, mimeType: "video/mp4", folderId: cfg.trainingProtocolFolderId, accessToken,
                });
              } finally {
                try { unlinkSync(tempPath); } catch {}
                try { unlinkSync(outPath); } catch {}
              }
            })();
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
    // Admin: which Drive folders the move search looks in (training protocol
    // page -> Settings). GET returns them with their Drive names.
    // Also carries the AI plan prompt (aiPrompt) shown in the same Settings window.
    if (p === "/api/chat/training-protocol/video-folders") {
      if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" });
      if (req.method === "POST") {
        const { folderIds, aiPrompt } = await readJsonBody(req);
        const ids = [...new Set((Array.isArray(folderIds) ? folderIds : []).map(extractDriveFolderId).map(x => x.trim()).filter(Boolean))];
        if (!ids.length) return sendJson(res, 400, { error: "Add at least one folder" });
        const cfg = getConfig();
        cfg.trainingProtocolVideoLibraryFolderIds = ids;
        cfg.trainingProtocolVideoLibraryFolderId = ids[0];
        // Saving the default text back (or blank) keeps following the built-in default.
        if (aiPrompt !== undefined) { const t = String(aiPrompt).trim(); cfg.protocolAiPrompt = t === DEFAULT_PROTOCOL_AI_PROMPT ? "" : t; }
        writeJson(CONFIG_FILE, cfg);
        folderTreeCache.clear(); videoLibraryCache.clear();
      }
      const ids = videoLibraryFolderIds();
      let folders = ids.map(id => ({ id, name: null }));
      try {
        const accessToken = await getDriveAccessToken();
        folders = await Promise.all(ids.map(async id => {
          const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
          const d = r.ok ? await r.json() : null;
          return { id, name: d?.name || null, ok: r.ok };
        }));
      } catch {}
      return sendJson(res, 200, { folders, aiPrompt: getConfig().protocolAiPrompt || DEFAULT_PROTOCOL_AI_PROMPT, defaultAiPrompt: DEFAULT_PROTOCOL_AI_PROMPT });
    }

    if (p === "/api/chat/training-protocol/search-videos" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const cfg = getConfig();
      const roots = videoLibraryFolderIds(cfg);
      if (!roots.length) return sendJson(res, 200, { files: [], needsConfig: true });
      try {
        const accessToken = await getDriveAccessToken();
        const q = (url.searchParams.get("q") || "").trim();
        const nameFilter = q ? ` and name contains '${q.replace(/'/g, "\\'")}'` : "";
        const folderIds = [...new Set((await Promise.all(roots.map(id => getAllDescendantFolderIds(id, accessToken)))).flat())];
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

    // A video step's `name` is whatever Drive filename it happened to be
    // uploaded/library-named with (often a long coach-authored string like
    // "LEE NINJA STRENGTH Human Flag #10 Straddle Flag Pullup.mp4") -- this
    // turns that into just the move itself ("Straddle Flag Pullup") so the
    // Flow canvas can show a short, readable label above the clip. Called
    // once per video step at creation time (training-protocol.html), not on
    // every render -- the result is saved onto the step (`moveLabel`) so
    // this never re-runs for a step that already has one.
    if (p === "/api/chat/training-protocol/label-video" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { filename } = await readJsonBody(req);
      if (!filename) return sendJson(res, 400, { error: "filename required" });
      try {
        const tool = {
          type: "function",
          function: {
            name: "submit_move_name",
            description: "Submit the short movement/exercise name extracted from a gym training video's filename.",
            parameters: {
              type: "object",
              properties: {
                moveName: { type: "string", description: "Just the movement name (e.g. 'Straddle Flag Pullup', 'Hip Bridge', 'Handstand Hold') -- no person's name, no gym/location, no 'KATA LEVEL' or numbering, no file extension. Title case, a few words." },
              },
              required: ["moveName"],
              additionalProperties: false,
            },
          },
        };
        const { refused, args } = await analyzeTextWithOpenAI({
          systemPrompt: "You label gym training-app video filenames with just the movement/exercise name they show, for a coach building a client's training protocol. Filenames are often formatted like 'FIRSTNAME LASTNAME LOCATION ELEMENT KATA LEVEL N APPARATUS MOVE' -- strip all of that down to only the move/exercise itself. Use ONLY words that appear in the filename, in the filename's wording: never add, rename, translate or guess words.",
          userPrompt: `Filename: ${filename}`,
          tool,
        });
        if (refused || !args?.moveName) return sendJson(res, 200, { moveLabel: null });
        // Keep only words that are really in the filename -- a made-up move
        // name is worse than the plain filename fallback.
        const fileWords = new Set(String(filename).toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, "").split(/[^a-z0-9]+/).filter(Boolean));
        const kept = String(args.moveName).split(/\s+/).filter(w => fileWords.has(w.toLowerCase().replace(/[^a-z0-9]/g, "")));
        if (!kept.length) return sendJson(res, 200, { moveLabel: null });
        return sendJson(res, 200, { moveLabel: kept.join(" ").slice(0, 60) });
      } catch (e) {
        // Best-effort labeling -- a failure here should never block saving
        // the video step itself, just leaves it on the filename fallback.
        return sendJson(res, 200, { moveLabel: null });
      }
    }

    // ─── AI-generated training plan ──────────────────────────────────────
    // A coach describes the client (days/week, volume, reps, focus, etc. --
    // free text, however they'd naturally write it) and gets back a
    // day-by-day draft to review/edit before it's saved for real. The model
    // only ever produces plain text content per day (never picks specific
    // Drive videos -- it has no way to judge whether a given clip is
    // actually right for this client), so the coach still attaches videos
    // to whichever steps want one, same as building by hand. A few of the
    // studio's own already-saved plans (real protocols with content, or
    // saved templates) are sampled as style/format examples when available;
    // with none yet saved, a small built-in example keeps the output in the
    // same shape instead of inventing a format from scratch.
    function sampleExistingPlansForPrompt(excludeUserId) {
      // The 12 most recently built/edited protocols (saved templates and
      // students' own protocols together, newest first) are the models.
      // Copies of the same plan (e.g. the default applied to many students)
      // count once.
      const candidates = [
        ...readJson(PROTOCOL_TEMPLATES_FILE, []).map(t => ({ steps: t.steps, at: t.updatedAt || t.createdAt })),
        ...Object.entries(readJson(TRAINING_PROTOCOLS_FILE, {}))
          .filter(([uid]) => uid !== excludeUserId && uid !== BUILDER_PROTOCOL_ID)
          .map(([, rec]) => ({ steps: rec?.steps, at: rec?.updatedAt })),
      ].filter(c => c.steps?.length).sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")));
      const samples = [], seenPlans = new Set();
      for (const c of candidates) {
        const sig = JSON.stringify(c.steps.map(st => [st.type, st.content || st.moveLabel || st.name || st.dayNumber || ""]));
        if (seenPlans.has(sig)) continue;
        seenPlans.add(sig);
        samples.push(c.steps);
        if (samples.length >= 12) break;
      }
      // Walk each sample's step graph the way the Flow canvas actually lays
      // it out, NOT a plain parentId chain: a day's own content lives down
      // its "below"/branch row (isBranchRoot:true), while "right" children
      // (isBranchRoot:false) are same-row continuations -- for a video step
      // that's an inline caption (a duration/rep count sitting next to it),
      // not a whole new line. Days themselves form the top row's rightward
      // chain. Getting this backwards (as an earlier version of this did,
      // walking the rightward chain for content) produced nothing like the
      // coach-authored protocols it was meant to be learning from.
      function walk(steps) {
        const byParent = new Map();
        steps.forEach(s => {
          const key = s.parentId || "root";
          if (!byParent.has(key)) byParent.set(key, []);
          byParent.get(key).push(s);
        });
        const childOf = (id, branch) => (byParent.get(id) || []).find(s => !!s.isBranchRoot === branch) || null;
        const lines = [];
        function renderLine(node) {
          if (node.type === "text" && node.content) return `- ${node.content}`;
          if (node.type === "video") {
            const caption = childOf(node.id, false);
            const captionText = caption?.type === "text" && caption.content ? ` (${caption.content})` : "";
            return `- [video: ${node.moveLabel || node.name || "clip"}]${captionText}`;
          }
          return null;
        }
        let day = childOf("root", false) || (byParent.get("root") || [])[0];
        while (day) {
          if (day.type === "day") lines.push(`Day ${day.dayNumber}`);
          let content = childOf(day.id, true);
          while (content) {
            const line = renderLine(content);
            if (line) lines.push(line);
            content = childOf(content.id, true);
          }
          day = childOf(day.id, false);
        }
        return lines.join("\n");
      }
      const rendered = samples.map(walk).filter(Boolean);
      if (rendered.length) return rendered.join("\n\n---\n\n");
      return [
        "Day 1",
        "- 4 rounds, rest 60s between rounds",
        "- [video: Push-Up] (8 reps)",
        "- [video: Hollow Body Hold] (30 seconds)",
        "- [video: Air Squat] (10 reps)",
        "- Coach note: focus on full range of motion, not speed",
        "Day 2",
        "- 3 rounds",
        "- [video: Pull-Up] (5 reps, scale to band-assisted if needed)",
        "- [video: Lunge] (10 each leg)",
        "- [video: L-Sit Hold] (20 seconds)",
      ].join("\n");
    }

    if (p === "/api/chat/training-protocol/ai-generate" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { prompt, targetUserId } = await readJsonBody(req);
      if (!prompt || !String(prompt).trim()) return sendJson(res, 400, { error: "A description of the client/plan is required" });
      // Remembered regardless of whether generation below actually succeeds
      // — the point is just to hold whatever the coach last typed here for
      // this client, so reopening the modal (even after a failed/refused
      // attempt they want to tweak and retry) shows it again instead of a
      // blank box.
      if (targetUserId) {
        const allProtocols = readJson(TRAINING_PROTOCOLS_FILE, {});
        allProtocols[targetUserId] = { ...allProtocols[targetUserId], lastAiPrompt: String(prompt) };
        writeJson(TRAINING_PROTOCOLS_FILE, allProtocols);
      }
      try {
        const tool = {
          type: "function",
          function: {
            name: "submit_training_plan",
            description: "Submit a structured multi-day training plan, matching how protocols are actually built in this app: each day is an ordered sequence of items, where most items are specific named movements (attached as a real video clip) and some are short structural notes (rounds/rest scheme, warmup, coach cues) that aren't tied to any one movement.",
            parameters: {
              type: "object",
              properties: {
                days: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      summary: { type: "string", description: "A short line naming this day's focus, e.g. 'Push Strength + Handstand Work'." },
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            kind: { type: "string", enum: ["exercise", "note"], description: "'exercise' for a specific named movement -- prefer this whenever the content is a movement, since it gets attached as a real video clip. 'note' only for structural lines that aren't a movement (rounds/rest scheme, warmup instruction, coach cue)." },
                            move: { type: "string", description: "Required for kind='exercise': just the movement name (e.g. 'Straddle Flag Pullup', 'Hip Bridge', 'Handstand Hold') -- title case, a few words, no sets/reps/duration in this field." },
                            caption: { type: "string", description: "For kind='exercise' only, optional: a short caption shown right next to the video, e.g. '10 seconds', '3x12', 'each side', 'scale to band-assisted'." },
                            text: { type: "string", description: "Required for kind='note': the note text itself, written the way a coach writes it in this app (e.g. '4 rounds, rest 60s between rounds')." },
                          },
                          required: ["kind"],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ["summary", "items"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["days"],
              additionalProperties: false,
            },
          },
        };
        const sample = sampleExistingPlansForPrompt(targetUserId);
        const { refused, args } = await analyzeTextWithOpenAI({
          systemPrompt: (getConfig().protocolAiPrompt || DEFAULT_PROTOCOL_AI_PROMPT) + "\n\nEXAMPLE FORMAT:\n" + sample,
          userPrompt: `Build a training plan for this client:\n\n${prompt}`,
          tool,
          reassurance: "This is a private, already-agreed-upon training plan for a real paying client of a legitimate bodyweight-strength coaching business -- please go ahead and draft it.",
        });
        if (refused || !args?.days?.length) return sendJson(res, 422, { error: "Could not generate a plan from that description — try adding more detail." });

        // Resolve every named movement against the real video library once
        // up front (one Drive listing, cached) so the canvas gets built with
        // actual attached clips, not just text describing them. A movement
        // with no good match falls back to a plain note client-side rather
        // than silently dropping it.
        const cfg = getConfig();
        let videoFiles = [];
        if (videoLibraryFolderIds(cfg).length) {
          try {
            const accessToken = await getDriveAccessToken();
            const seen = new Set();
            videoFiles = (await Promise.all(videoLibraryFolderIds(cfg).map(id => listVideoLibraryFiles(id, accessToken)))).flat()
              .filter(f => !seen.has(f.id) && seen.add(f.id));
          } catch (e) { /* best-effort -- fall through with no videos matched */ }
        }
        // No duplicate moves or videos anywhere in the plan, whatever the
        // model returned: a repeated move name, or a move that matches a
        // video already used, is dropped.
        const usedMoves = new Set(), usedVideos = new Set();
        const days = args.days.map(day => ({
          summary: day.summary || "",
          items: (day.items || []).map(item => {
            if (item.kind === "exercise" && item.move) {
              const key = String(item.move).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
              if (usedMoves.has(key)) return null;
              const match = matchVideoForMove(item.move, videoFiles);
              if (match && usedVideos.has(match.id)) return null;
              usedMoves.add(key);
              if (match) usedVideos.add(match.id);
              return { kind: "exercise", move: item.move, caption: item.caption || "", driveFileId: match?.id || null, name: match?.name || null };
            }
            return { kind: "note", text: item.text || item.move || "" };
          }).filter(Boolean),
        }));
        return sendJson(res, 200, { days });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // Pushes a built step graph (either a specific student's own Your Flow/
    // Your Page, or the shared Flow Builder draft — the client doesn't
    // distinguish the two here, it's just "steps") out to one student, or
    // to every online/gym client who doesn't already have a custom protocol
    // of their own. Same per-student record (TRAINING_PROTOCOLS_FILE) and
    // the same GET/POST above read/write — this only adds a bulk,
    // name-carrying way to populate it, reusing fresh step/parent ids per
    // target exactly like the client's own cloneStepsWithFreshIds (training-
    // protocol.html) so no two students (or re-applications) ever share ids.
    if (p === "/api/chat/training-protocol/apply" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { steps, name, targetUserId, toAllBlank } = await readJsonBody(req);
      if (!Array.isArray(steps) || !steps.length) return sendJson(res, 400, { error: "Nothing to apply — this protocol has no steps yet" });
      if (!targetUserId && !toAllBlank) return sendJson(res, 400, { error: "Pick a student, or everyone without a custom protocol" });
      const protocolName = String(name || "").trim() || null;
      const cloneWithFreshIds = () => {
        const idMap = new Map();
        steps.forEach(s => idMap.set(s.id, randomUUID()));
        return steps.map(s => ({ ...s, id: idMap.get(s.id), parentId: s.parentId ? idMap.get(s.parentId) : null }));
      };
      const allProtocols = readJson(TRAINING_PROTOCOLS_FILE, {});
      const applyTo = (uid) => {
        allProtocols[uid] = { ...allProtocols[uid], steps: cloneWithFreshIds(), protocolName, updatedAt: new Date().toISOString(), updatedBy: user.id };
      };
      let appliedCount = 0;
      if (toAllBlank) {
        const users = readJson(USERS_FILE, []);
        users.filter(u => !u.archived && isClientRole(u.role)).forEach(u => {
          if (!allProtocols[u.id]?.steps?.length) { applyTo(u.id); appliedCount++; }
        });
      } else {
        applyTo(targetUserId);
        appliedCount = 1;
      }
      writeJson(TRAINING_PROTOCOLS_FILE, allProtocols);
      return sendJson(res, 200, { ok: true, appliedCount });
    }

    // Whether the shared Flow Builder draft should be auto-applied to
    // every brand new online/gym client going forward (see syncDefaultGroups,
    // which is what actually clones it onto a new student the moment their
    // own personal group gets created). A plain boolean on the admin config
    // rather than snapshotting the draft's steps anywhere -- toggling this
    // on always means "whatever the builder draft currently holds," same
    // live-read relationship Apply's "everyone blank" case already has with
    // the draft, not a frozen copy from the moment the toggle was flipped.
    if (p === "/api/chat/training-protocol/default-protocol" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      return sendJson(res, 200, { enabled: !!getConfig().defaultProtocolEnabled });
    }
    if (p === "/api/chat/training-protocol/default-protocol" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches only" });
      const { enabled } = await readJsonBody(req);
      const cfg = getConfig();
      cfg.defaultProtocolEnabled = !!enabled;
      saveConfig(cfg);
      return sendJson(res, 200, { ok: true, enabled: cfg.defaultProtocolEnabled });
    }

    // Temporary diagnostic -- see reportVideoError in training-protocol.html.
    // No device access to actually see what a real iPhone's <video> element
    // reports when a step video fails there, so this has the device log it
    // here instead: `railway logs` after a student retries a broken one is
    // what this is actually for. Open to any logged-in user (not staff-
    // only like the rest of this file's training-protocol routes), since
    // it's students' own phones hitting the failure, not a coach's.
    if (p === "/api/chat/training-protocol/video-error" && req.method === "POST") {
      const body = await readJsonBody(req);
      console.error("[video-error]", JSON.stringify({ userId: user.id, role: user.role, ...body }));
      return sendJson(res, 200, { ok: true });
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
        // No search yet: GIFs already sent in chats come first.
        let sent = [];
        if (!q) { try { sent = MessagesDB.getTopGifUrls(24).map(u => ({ preview: u.replace(/\/giphy\.gif(\?.*)?$/, "/200w.gif"), full: u })); } catch {} }
        return sendJson(res, 200, { gifs, sent });
      } catch (e) {
        return sendJson(res, 200, { gifs: [], error: e.message });
      }
    }

    // ─── Content to send (composer's Videos tab, staff only) ──────────────
    // Long-form YouTube from all 3 brands + videos in the PRA Drive (minus
    // chat uploads, call recordings and other per-student folders). Empty
    // query = newest YouTube videos. Drive files sent from here go out as a
    // normal video message (same driveFileId, streamed by /api/chat/media).
    if (p === "/api/chat/content" && req.method === "GET") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const q = (url.searchParams.get("q") || "").trim();
      const [youtube, drive] = await Promise.all([
        searchYouTube(q, q ? 60 : 40).catch(e => { console.error("[content yt]", e.message); return []; }),
        q ? searchDriveVideos(q).catch(e => { console.error("[content drive]", e.message); return []; }) : Promise.resolve([]),
      ]);
      return sendJson(res, 200, { youtube, drive });
    }

    // ─── Voice note -> text (composer mic, staff only) ────────────────────
    if (p === "/api/chat/transcribe" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      try { return sendJson(res, 200, { text: await transcribeRequestAudio(req) }); }
      catch (e) { console.error("[transcribe]", e.message); return sendJson(res, 500, { error: e.message }); }
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
      // ?kind=student lists the per-student custom protocols (built from each
      // student's old custom.pacificrimathletics.com page, ready to drop onto
      // that student once they join the app) -- kept out of the regular
      // template list so it stays a short menu of reusable programs.
      const wantStudent = url.searchParams.get("kind") === "student";
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []).filter(t => (t.kind === "student") === wantStudent);
      // Which of those students already have an app account (matched by name).
      const nameKey = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
      const accounts = wantStudent
        ? new Map(readJson(USERS_FILE, []).filter(u => u.role === "online" || u.role === "gym").map(u => [nameKey(`${u.first}${u.last}`), u.id]))
        : new Map();
      // Whether that account's current protocol is a custom one of their own
      // (Edit opens it) -- not empty and not one of the shared templates
      // (e.g. Simple But Brutal), whether linked by id or just by its name.
      const protocols = wantStudent ? readJson(TRAINING_PROTOCOLS_FILE, {}) : {};
      const shared = readJson(PROTOCOL_TEMPLATES_FILE, []).filter(t => t.kind !== "student");
      const sharedIds = new Set(shared.map(t => t.id));
      const sharedNames = new Set(shared.map(t => t.name.trim().toLowerCase()));
      const hasCustom = (uid) => {
        const pr = uid && protocols[uid];
        if (!pr || !(pr.steps || []).length) return false;
        if (pr.templateId && sharedIds.has(pr.templateId)) return false;
        const nm = String(pr.protocolName || "").trim().toLowerCase();
        return !(nm && sharedNames.has(nm)) && !/simple (but brutal )?powerbatics basics/i.test(nm);
      };
      const list = templates
        .map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, stepCount: t.steps.length,
          ...(t.kind ? { kind: t.kind } : {}),
          // Program templates (drip settings live on the template itself).
          ...(t.settings || t.kind === "program" ? { isProgram: true, settings: programSettings(t) } : {}),
          ...(wantStudent ? { studentName: t.studentName || "", pageTitle: t.pageTitle || "", sourceUrl: t.sourceUrl || "",
            days: t.steps.filter(s => s.type === "day").length, videos: t.steps.filter(s => s.type === "video").length,
            accountId: accounts.get(nameKey(t.studentName)) || null,
            accountHasCustom: hasCustom(accounts.get(nameKey(t.studentName))) } : {}) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, { templates: list });
    }
    if (p === "/api/chat/protocol-templates" && req.method === "POST") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      const { name, steps, kind } = await readJsonBody(req);
      if (!String(name || "").trim()) return sendJson(res, 400, { error: "Name is required" });
      if (!Array.isArray(steps) || !steps.length) return sendJson(res, 400, { error: "Nothing to save — this protocol has no steps yet" });
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const template = { id: randomUUID(), name: name.trim(), steps, createdAt: new Date().toISOString(), savedBy: user.id };
      // Programs Editor (programs-editor.html) creates program templates.
      if (kind === "program") { if (!isAdmin(user)) return sendJson(res, 403, { error: "Admins only" }); template.kind = "program"; template.settings = programSettings({}); template.bumps = {}; template.goal = ""; }
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
    // Keeps a template's own saved name in sync with the title of whatever
    // protocol it was saved-as/loaded-from -- see saveProtocolName in
    // training-protocol.html, which calls this right after renaming the
    // protocol itself, whenever the page has a loadedTemplateId linking it
    // to one. Best-effort on the client side (never blocks the actual
    // title save), so this only ever needs to handle the rename itself.
    if (protocolTemplateMatch && req.method === "PATCH") {
      if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
      // Also takes `steps`: a template opened in the Flow Builder saves its
      // edits back here (saveSteps in training-protocol.html).
      // ...and `settings`: a program template's drip/CTA settings (Protocol
      // Settings modal), merged over the current ones.
      // ...and `bumps` / `goal`: a program template's add-ons and goal line
      // (the Flow Builder's program editor). Every other field on the record
      // (kind, settings, builtAt, anything unknown) is left exactly as it is.
      const { name, steps, settings, bumps, goal } = await readJsonBody(req);
      if (name === undefined && !(Array.isArray(steps) && steps.length) && settings === undefined && bumps === undefined && goal === undefined) return sendJson(res, 400, { error: "Name, steps, settings, bumps or goal required" });
      if (name !== undefined && !String(name || "").trim()) return sendJson(res, 400, { error: "Name is required" });
      const templates = readJson(PROTOCOL_TEMPLATES_FILE, []);
      const template = templates.find(t => t.id === protocolTemplateMatch[1]);
      if (!template) return sendJson(res, 404, { error: "Template not found" });
      // A program's step ids are what enrolled users and install_template.mjs
      // key on -- refuse a save that would lose or duplicate one.
      if (template.kind === "program" && Array.isArray(steps) && steps.length) {
        const ids = steps.map(s => s && typeof s === "object" ? s.id : null);
        if (ids.some(id => typeof id !== "string" || !id)) return sendJson(res, 400, { error: "Every step needs an id" });
        if (new Set(ids).size !== ids.length) return sendJson(res, 400, { error: "Duplicate step ids" });
      }
      if (bumps !== undefined) {
        const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
        if (!isObj(bumps) || Object.keys(bumps).length > 30) return sendJson(res, 400, { error: "Add-ons must be an object" });
        for (const b of Object.values(bumps)) {
          if (!isObj(b) || (b.moves !== undefined && (!Array.isArray(b.moves) || b.moves.length > 100 || !b.moves.every(isObj)))) return sendJson(res, 400, { error: "Each add-on needs a moves list" });
        }
      }
      if (goal !== undefined && typeof goal !== "string") return sendJson(res, 400, { error: "Goal must be text" });
      if (name !== undefined) template.name = name.trim();
      if (Array.isArray(steps) && steps.length) { template.steps = steps; template.updatedAt = new Date().toISOString(); }
      if (bumps !== undefined) { template.bumps = bumps; template.updatedAt = new Date().toISOString(); }
      if (goal !== undefined) { template.goal = goal.trim().slice(0, 300); template.updatedAt = new Date().toISOString(); }
      if (settings !== undefined) {
        try { template.settings = sanitizeProgramSettings(settings, template.settings); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        template.settingsUpdatedAt = new Date().toISOString();
        template.settingsUpdatedBy = user.id;
      }
      writeJson(PROTOCOL_TEMPLATES_FILE, templates);
      return sendJson(res, 200, { ok: true, ...(settings !== undefined ? { settings: programSettings(template) } : {}) });
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
        const msg = MessagesDB.getMessageById(body.messageId);
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
    // ── Profile badges ─────────────────────────────────────────────────────
    // Counts per person for the current month (their timezone), ranked
    // across everyone: distinct days Fuel was tracked, physique photos,
    // moves (videos uploaded), steps logged, hearts, katas.
    // Rank 1/2/3 = gold/silver/bronze on the client. Cached 5 minutes.
    if (p === "/api/chat/badges" && req.method === "GET") {
      if (!badgesCache || Date.now() - badgesCache.at > 5 * 60 * 1000) badgesCache = { at: Date.now(), data: computeBadges() };
      return sendJson(res, 200, rankBadgesFor(user, badgesCache.data));
    }
    // Quick Start (Lee, 2026-11-24): another student whose moves feed is
    // public, to show what a feed looks like -- one of the 5 with the most clips.
    if (p === "/api/chat/moves/showcase" && req.method === "GET") {
      const cands = readJson(USERS_FILE, []).filter(u => !u.archived && u.id !== user.id && ["online", "gym"].includes(u.role) && !u.noMedia && movesVisible(u))
        .map(u => ({ id: u.id, n: movesForUser(u).length })).filter(x => x.n >= 3).sort((a, b) => b.n - a.n).slice(0, 5);
      const pick = cands[Math.floor(Math.random() * cands.length)];
      return sendJson(res, 200, { userId: pick?.id || null });
    }
    const userMovesMatch = p.match(/^\/api\/chat\/user-moves\/([^/]+)$/);
    if (userMovesMatch && req.method === "GET") {
      const target = readJson(USERS_FILE, []).find(u => u.id === userMovesMatch[1] && !u.archived);
      if (!target) return sendJson(res, 404, { error: "User not found" });
      const isSelf = target.id === user.id;
      const showMoves = movesVisible(target);
      // Enough to draw a profile header (last name only for staff/self, same
      // rule as the rest of the app).
      const owner = { id: target.id, first: target.first, last: (isStaff(user) || isSelf) ? target.last : "", role: target.role, profilePictureFileId: target.profilePictureFileId || null };
      if (!showMoves && !isSelf && !isStaff(user)) return sendJson(res, 200, { owner, showMoves, isSelf, hidden: true, total: 0, videos: [] });
      const offset = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);
      const limit = Math.min(30, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 6));
      const all = movesForUser(target);
      const likes = readJson(MOVE_LIKES_FILE, {});
      const videos = all.slice(offset, offset + limit).map(m => ({
        id: m.id, driveFileId: m.driveFileId, name: m.name || "", createdAt: m.createdAt,
        likes: (likes[m.id] || []).length, likedByMe: (likes[m.id] || []).includes(user.id),
      }));
      return sendJson(res, 200, { owner, showMoves, isSelf, hidden: false, total: all.length, videos });
    }
    // Heart a move (double-tap). Body { like: true|false }.
    const moveLikeMatch = p.match(/^\/api\/chat\/moves\/([^/]+)\/like$/);
    if (moveLikeMatch && req.method === "POST") {
      const msg = MessagesDB.getMessageById(moveLikeMatch[1]);
      if (!msg || msg.type !== "video") return sendJson(res, 404, { error: "Move not found" });
      const owner = readJson(USERS_FILE, []).find(u => u.id === msg.senderId);
      const canSee = owner && (movesVisible(owner) || owner.id === user.id || isStaff(user));
      if (!canSee) return sendJson(res, 403, { error: "This move is private" });
      const { like } = await readJsonBody(req);
      const likes = readJson(MOVE_LIKES_FILE, {});
      const set = new Set(likes[msg.id] || []);
      if (like === false) set.delete(user.id); else set.add(user.id);
      likes[msg.id] = [...set];
      writeJson(MOVE_LIKES_FILE, likes);
      const likeTimes = readJson(MOVE_LIKE_TIMES_FILE, {});
      const times = likeTimes[msg.id] || (likeTimes[msg.id] = {});
      if (like === false) delete times[user.id]; else if (!times[user.id]) times[user.id] = new Date().toISOString();
      writeJson(MOVE_LIKE_TIMES_FILE, likeTimes);
      badgesCache = null;
      return sendJson(res, 200, { likes: set.size, likedByMe: set.has(user.id) });
    }
    if (p === "/api/chat/me/show-moves" && req.method === "POST") {
      const { show } = await readJsonBody(req);
      const users = readJson(USERS_FILE, []);
      const me = users.find(u => u.id === user.id);
      if (!me) return sendJson(res, 404, { error: "User not found" });
      me.showMoves = !!show;
      writeJson(USERS_FILE, users);
      return sendJson(res, 200, { ok: true, showMoves: me.showMoves });
    }

    if (p === "/api/chat/conversations" && req.method === "GET") {
      if (!isTrainee(user)) ensureSelfConvo(user);
      const blockedUserIds = new Set(readJson(BLOCKS_FILE, []).filter(b => b.blockerId === user.id).map(b => b.blockedId));
      const convos = readJson(CONVOS_FILE, []).filter(c => c.participantIds.includes(user.id))
        .filter(c => c.type !== "dm" || !c.participantIds.some(id => blockedUserIds.has(id)));
      // One indexed query covering every one of this user's conversations
      // (see chat_messages_sqlite.js's getLastMessages) instead of filtering
      // the entire message history once per conversation -- this used to be
      // the single most expensive thing this 3s-polled endpoint did, and it
      // only got slower as real message history grew.
      const lastByConvo = MessagesDB.getLastMessages(convos.map(c => c.id));
      const users = readJson(USERS_FILE, []);
      const favoriteIds = new Set(user.favoriteConvoIds || []);
      const pinnedIds = new Set(user.pinnedConvoIds || []);
      const readState = user.readState || {};
      // Staff only; best-effort (a Sheets hiccup just means no alerts this poll).
      let renewalEligibility = null;
      if (isStaff(user)) { try { renewalEligibility = await fetchStudentEligibility(); } catch { renewalEligibility = null; } }
      let holds = null;
      if (isStaff(user)) { try { holds = await crmOnHoldContacts(); } catch { holds = null; } }
      const enriched = convos.map(c => {
        const last = lastByConvo.get(c.id) || null;
        const lastReadAt = readState[c.id];
        const unreadCount = MessagesDB.getUnreadCount(c.id, user.id, lastReadAt);
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
          renewal: (() => { const r = renewalForConvo(c, users, user, renewalEligibility); return r ? { level: r.level, endDate: r.endDate, unhandled: r.unhandled } : null; })(),
          hold: isStaff(user) ? holdForStudent(renewalStudentFor(c, users, user.id), user, holds) : null,
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
      // Same callee rule as ringCallees: in a student's coaching group only
      // the student is offered the call, not every coach in the group.
      const incomingCall = readJson(CALLS_FILE, []).find(c => {
        if (c.status !== "ringing" || !myOpenConvoIds.has(c.conversationId)) return false;
        if (!c.participantIds.includes(user.id) || c.joinedIds.includes(user.id) || c.declinedIds.includes(user.id)) return false;
        const cv = convos.find(x => x.id === c.conversationId);
        return cv?.autoGroupType !== "student" || cv.autoGroupUserId === user.id;
      });
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
      // Seeing the conversation also acknowledges its renewal alert (per staff member) --
      // it comes back when the alert steps up from orange to pink.
      if (isStaff(target)) {
        try {
          const convo = convos.find(c => c.id === convoId);
          const rn = renewalForConvo(convo, users, target, await fetchStudentEligibility());
          if (rn) { target.renewAck = target.renewAck || {}; target.renewAck[rn.studentId] = rn.levelNum; }
        } catch { /* best-effort */ }
      }
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

      // Composer right-click / long-press "Links": app pages the people in
      // this chat can open (User Management > Access by Role). A student's
      // own group = that student; otherwise only what EVERY non-staff member can see.
      if (sub === "/link-options" && req.method === "GET") {
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
        const users = readJson(USERS_FILE, []);
        const people = convo.autoGroupType === "student" && convo.autoGroupUserId
          ? [users.find(u => u.id === convo.autoGroupUserId)].filter(Boolean)
          : convo.participantIds.map(id => users.find(u => u.id === id)).filter(u => u && !isStaff(u));
        const all = Object.fromEntries(ACCESS_FEATURES.map(f => [f.key, true]));
        const acc = people.length ? people.map(accessFor).reduce((a, b) => Object.fromEntries(Object.keys(all).map(k => [k, !!a[k] && !!b[k]]))) : all;
        const one = people.length === 1 ? people[0] : null;
        const base = "https://" + (req.headers["x-forwarded-host"] || req.headers.host);
        const first = one ? (one.first || "Their") : "";
        const links = [];
        if (one && acc.protocol) links.push({ label: `${first}'s Custom Training Protocol`, path: `/chat-app/training-protocol.html?userId=${encodeURIComponent(one.id)}` });
        if (one && acc.katas) links.push({ label: `${first}'s Katas`, path: `/chat-app/training-protocol.html?userId=${encodeURIComponent(one.id)}&view=katas` });
        const pages = [["physique", "Body Mastery Builder", "/chat-app/body-scan.html"], ["videos", "Powerbatics Training Videos", "/chat-app/moves-dictionary.html"],
          ["levels", "Levels", "/chat-app/levels.html"], ["map", "Strength Ninjas map", "/chat-app/users-map.html"], ["quiz", "Training Personality Quiz", "/personality-quiz/index.html"],
          ["shop", "Shop", "/chat-app/shop.html"], ["retreats", "Retreats", "/chat-app/retreats.html"]];
        for (const [k, label, path] of pages) if (acc[k]) links.push({ label, path });
        links.push({ label: "Their profile", path: "/chat-app/profile.html" });
        return sendJson(res, 200, {
          forWho: one ? `${one.first || ""} ${one.last || ""}`.trim() : (people.length ? `everyone in this chat (${people.length})` : "this chat"),
          links: links.map(l => ({ label: l.label, url: base + l.path })),
        });
      }

      // Delete the whole group — DMs aren't deletable this way since there's
      // no "everyone else" left to keep it around for.
      if (sub === "" && req.method === "DELETE") {
        if (convo.type !== "group") return sendJson(res, 400, { error: "Only groups can be deleted" });
        if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
        writeJson(CONVOS_FILE, convos.filter(c => c.id !== convoId));
        MessagesDB.deleteMessagesForConversation(convoId);
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
            // Joining a call that's already live (a coach tapping the green
            // video button) -- count them as on the call.
            if (existing.status === "active" && !existing.joinedIds.includes(user.id)) {
              const all = readJson(CALLS_FILE, []);
              const c = all.find(x => x.id === existing.id);
              if (c) { c.joinedIds.push(user.id); writeJson(CALLS_FILE, all); }
            }
            const token = await createDailyMeetingToken(existing.dailyRoomName, user.id, `${user.first} ${user.last}`, user.id === existing.initiatorId);
            return sendJson(res, 200, { call: publicCall(existing), token });
          }
          // Only coaches/admins can PLACE a call -- joining one already
          // ringing (the branch above) stays open to any participant, since
          // that's the callee accepting, not initiating.
          if (!isStaff(user)) return sendJson(res, 403, { error: "Coaches and admins only" });
          const calls = readJson(CALLS_FILE, []);
          const room = await createDailyRoom(`call-${randomUUID()}`);
          // Calling from your own "(You)" notes thread is a ring test: nobody
          // counts as joined yet, so every one of your OTHER devices rings
          // (push + banner) and answering on one of them starts the call.
          const selfTest = convo.autoGroupType === "self";
          const call = {
            id: randomUUID(), conversationId: convoId, initiatorId: user.id, ...(selfTest ? { selfTest: true } : {}),
            participantIds: [...convo.participantIds], joinedIds: selfTest ? [] : [user.id], declinedIds: [],
            status: "ringing", dailyRoomName: room.name, dailyRoomUrl: room.url,
            createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
          };
          calls.push(call);
          writeJson(CALLS_FILE, calls);
          ringCallees(call.id, user);
          for (let t = CALL_RING_REPEAT_MS; t < CALL_RING_MS; t += CALL_RING_REPEAT_MS) setTimeout(() => ringCallees(call.id, user), t);
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

      // A call problem the person on the call can't fix themselves (broken
      // browser, camera/mic error with no clear cause, Daily failing to
      // connect). They never see it -- it goes to the admins' red banner.
      // Problems they CAN fix (camera busy in Zoom, blocked permission, weak
      // Wi-Fi) are shown to them on the call screen instead, never sent here.
      const callIssueMatch = sub.match(/^\/call\/([^/]+)\/issue$/);
      if (callIssueMatch && req.method === "POST") {
        const call = readJson(CALLS_FILE, []).find(c => c.id === callIssueMatch[1] && c.conversationId === convoId);
        if (!call) return sendJson(res, 404, { error: "Call not found" });
        const { kind, detail } = await readJsonBody(req);
        const k = String(kind || "unknown").replace(/[^\w-]/g, "").slice(0, 40) || "unknown";
        const what = {
          "join-failed": "couldn't connect to the call at all",
          "media-unsupported": "their browser/app can't use a camera or mic (often an in-app browser like Instagram's, or an old browser)",
          "camera-error": "camera/mic failed for an unknown reason",
          "call-error": "the call dropped with an error",
        }[k] || k;
        const who = `${user.first} ${user.last}`.trim();
        const extra = String(detail || "").slice(0, 240);
        console.log(`[call issue] ${call.id} ${who}: ${k} ${extra}`);
        addStaffAlert({ id: `call:${call.id}:${user.id}:${k}`, kind: "call-issue", adminOnly: true, userId: user.id,
          link: "/chat-app/chat.html?convo=" + encodeURIComponent(convoId),
          title: `${who}: video call problem`,
          detail: `${what[0].toUpperCase() + what.slice(1)}.${extra ? ` (${extra})` : ""}` });
        return sendJson(res, 200, { ok: true });
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
          if (call.status === "ringing" && (call.joinedIds.length >= 2 || call.selfTest)) { call.status = "active"; call.startedAt = new Date().toISOString(); }
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
            if (call.startedAt && !call.selfTest) archiveCallRecording(call); // fire-and-forget, see its own comment
          } else {
            writeJson(CALLS_FILE, calls);
          }
          return sendJson(res, 200, { call: publicCall(call) });
        }
      }

      if (sub === "/messages" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 50;
        const before = url.searchParams.get("before");
        let msgs = MessagesDB.getConversationMessages(convoId, { before, limit });

        // Read receipts, "delivered" half: this requester's client just
        // fetched these messages, so anything not their own just reached
        // them — stamp it. Only the (at most `limit`) rows actually in this
        // page get touched, not the whole conversation's history.
        msgs.forEach(m => {
          if (m.senderId === user.id) return;
          const deliveredTo = m.deliveredTo || [];
          if (!deliveredTo.includes(user.id)) {
            deliveredTo.push(user.id);
            m.deliveredTo = deliveredTo;
            MessagesDB.updateMessageFields(m.id, { deliveredTo });
          }
        });

        // "read" half + the sent/delivered/read status ticks show on your
        // OWN messages — computed here so the client just renders whatever
        // this says, rather than re-deriving it from raw deliveredTo/
        // readState data it would otherwise need every other participant's
        // user record for. receipts is the real per-person breakdown the
        // in-thread bubble renders (one tick per recipient); status is only
        // the sidebar preview's single-glyph shortcut.
        const users = readJson(USERS_FILE, []);
        msgs = msgs.map(m => m.senderId === user.id
          ? { ...m, status: computeMessageStatus(m, convo, users), receipts: computeMessageReceipts(m, convo, users) }
          : m);

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
        let isKata = false; // camera upload's "Is this a kata?" toggle
        const pendingVideoJobs = [];
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
              if (name === "kata") isKata = val === "true";
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
                // Video: save it to a temp file, grab a first-frame thumbnail,
                // and post the message right away -- conversion + Drive upload
                // happen in the background (processChatVideo) so a big clip
                // never blocks the server or times out the sender's phone.
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
                    const wantsTrim = Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart;
                    let posterFileId = null;
                    try {
                      const thumb = await extractVideoFrameAsync(tempPath, wantsTrim ? Math.max(0, trimStart) + 0.1 : 0.1, 480);
                      if (thumb) {
                        const r = await uploadStreamToDrive(Readable.from(thumb), {
                          name: `${user.first} ${user.last} VIDEO THUMBNAIL.jpg`.toUpperCase(),
                          mimeType: "image/jpeg", folderId: cfg.chatImagesFolderId, accessToken,
                        });
                        posterFileId = r.id;
                      }
                    } catch (e) { console.error("[chat video thumbnail]", e.message); }
                    const msgId = randomUUID();
                    pendingVideoJobs.push({ msgId, tempPath, ext, mimeType: info.mimeType, trim: wantsTrim ? { start: trimStart, end: trimEnd } : null, user, folderId: cfg.chatVideosFolderId });
                    return { type, msgId, driveFileId: null, posterFileId, mimeType: info.mimeType, name: info.filename };
                  } catch (e) {
                    stream.resume();
                    try { unlinkSync(tempPath); } catch {}
                    return { error: e.message, name: info.filename };
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
            const now = Date.now();
            const toInsert = [];
            results.forEach((r, i) => {
              if (r.error) return;
              const msg = {
                id: r.msgId || randomUUID(), conversationId: convoId, senderId: user.id,
                type: r.type, driveFileId: r.driveFileId || undefined, posterFileId: r.posterFileId || undefined, mimeType: r.mimeType, name: r.name,
                // The "FIRST LAST BEST-GUESS" label already used as this
                // file's own Drive filename (see guessContentLabel above) —
                // carried onto the message record too so the favorite-star
                // popup can pre-fill a sensible name instead of a blank
                // field, without a round-trip to look it up.
                driveFileName: r.driveFileName,
                feedGroupId, createdAt: new Date(now + i).toISOString(),
              };
              toInsert.push(msg);
              created.push(msg);
            });
            MessagesDB.insertMessages(toInsert);
            for (const job of pendingVideoJobs) {
              if (toInsert.some(m => m.id === job.msgId)) enqueueChatVideo(job).catch(() => {});
              else { try { unlinkSync(job.tempPath); } catch {} }
            }
            if (isKata) {
              const katas = readJson(KATAS_FILE, {});
              toInsert.filter(m => m.type === "video").forEach(m => { katas[m.id] = { senderId: m.senderId, createdAt: m.createdAt }; });
              writeJson(KATAS_FILE, katas);
              badgesCache = null;
            }
          });
        } else if (req.headers["content-type"]?.includes("application/json") === false) {
          return sendJson(res, 400, { error: "text or gifUrl required" });
        } else {
          const body = await readJsonBody(req);
          if (body.forwardMessageId) {
            // Forwarding just clones the source message's content fields into
            // this conversation — the sender must be a participant of
            // wherever the original lives, same access rule as any other
            // read, so this can't be used to pull a message out of a thread
            // you're not actually in.
            const src = MessagesDB.getMessageById(body.forwardMessageId);
            if (!src) return sendJson(res, 404, { error: "Original message not found" });
            const srcConvo = convos.find(c => c.id === src.conversationId);
            if (!srcConvo || !srcConvo.participantIds.includes(user.id)) return sendJson(res, 403, { error: "Not allowed to forward this message" });
            if (src.type === "appointment") return sendJson(res, 400, { error: "Appointments can't be forwarded" });
            const msg = {
              id: randomUUID(), conversationId: convoId, senderId: user.id,
              type: src.type, text: src.text,
              driveFileId: src.driveFileId, mimeType: src.mimeType, name: src.name, driveFileName: src.driveFileName,
              // asOriginal: the bulk composer copying one upload into many
              // chats -- it's the sender's own message, not a forward.
              forwarded: body.asOriginal ? false : true,
              createdAt: new Date().toISOString(),
            };
            MessagesDB.insertMessage(msg);
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
              // n.time can be null -- a note sent without ever hitting "Add
              // Timestamp" (plain "good job"-style reply) -- which must stay
              // null rather than coercing to 0, or it'd render as a
              // clickable 0:00 badge indistinguishable from a real
              // start-of-video timestamp.
              videoNotes: Array.isArray(body.videoNotes) && body.videoNotes.length
                ? body.videoNotes.map(n => ({ time: n.time == null ? null : (Number(n.time) || 0), text: String(n.text || "").slice(0, 2000) }))
                : undefined,
              createdAt: new Date().toISOString(),
            };
            MessagesDB.insertMessage(msg);
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
          logActivity(user.id, "message_sent", first.forwarded ? "Forwarded a message" : `Sent a message: ${preview}`, { conversationId: convoId });
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
        MessagesDB.insertMessage(msg);

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
        // A Gym student can also book from their own coaching group (all 11
        // have one; most have no 1:1 chat). Staff keep the 1:1 rule.
        const ownGymGroup = convo.type === "group" && convo.autoGroupType === "student" && convo.autoGroupUserId === user.id && user.role === "gym";
        if (convo.type !== "dm" && !ownGymGroup) return sendJson(res, 400, { error: "Gym scheduling is only available in a 1:1 chat" });
        const users = readJson(USERS_FILE, []);
        const otherId = convo.type === "dm" ? convo.participantIds.find(id => id !== user.id) : null;
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

        if (isGymSlotBlocked(date, slot)) return sendJson(res, 400, { error: "That date or time isn't available for scheduling" });

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

        const msg = {
          id: msgId, conversationId: convoId, senderId: user.id, type: "appointment",
          startISO, durationMinutes,
          timezone: ANCHORAGE, // Gym slots are always shown as Anchorage time, not per-viewer
          isGym: true, clientIds: [clientCandidate.id],
          googleEventId, googleEventLink, googleEventIds: googleEventId ? [googleEventId] : [], googleEventLinks: googleEventLink ? [googleEventLink] : [],
          createdAt: new Date().toISOString(),
        };
        MessagesDB.insertMessage(msg);

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
        const msgs = MessagesDB.searchConversationText(convoId, q);
        return sendJson(res, 200, { messages: msgs });
      }

      if (sub === "/media" && req.method === "GET") {
        const msgs = MessagesDB.getConversationMedia(convoId);
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
        const msg = MessagesDB.getMessageById(messageId);
        if (!msg || msg.conversationId !== convoId) return sendJson(res, 404, { error: "Message not found" });
        msg.reactions = msg.reactions || [];
        const idx = msg.reactions.findIndex(r => r.userId === user.id && r.emoji === emoji);
        const removing = idx >= 0;
        if (removing) msg.reactions.splice(idx, 1);
        else msg.reactions.push({ userId: user.id, emoji });
        MessagesDB.updateMessageFields(messageId, { reactions: msg.reactions });
        if (!removing) logActivity(user.id, "reaction_added", `Reacted ${emoji} to a message`, { conversationId: convoId, messageId });
        return sendJson(res, 200, { reactions: msg.reactions });
      }

      // ── Delete / edit a message (staff only) ──────────────────────────────
      const msgMatch = sub.match(/^\/messages\/([^/]+)$/);
      if (msgMatch && (req.method === "DELETE" || req.method === "PATCH")) {
        const messageId = msgMatch[1];
        const existing = MessagesDB.getMessageById(messageId);
        if (!existing || existing.conversationId !== convoId) return sendJson(res, 404, { error: "Message not found" });
        if (req.method === "DELETE") {
          const deleted = existing;
          // Staff can cancel any appointment; a gym client can additionally
          // cancel their own Gym slot booking without needing staff — Gym
          // is the one appointment type visible/self-serviceable to clients
          // at all. Every other message type stays staff-only.
          const canCancelOwnGym = deleted.type === "appointment" && deleted.isGym && user.role === "gym" && deleted.clientIds?.includes(user.id);
          if (!isStaff(user) && !canCancelOwnGym) return sendJson(res, 403, { error: "Staff only" });
          MessagesDB.deleteMessageById(messageId);

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
        if (existing.type !== "text") return sendJson(res, 400, { error: "Only text messages can be edited" });
        const editedAt = new Date().toISOString();
        MessagesDB.updateMessageFields(messageId, { text, editedAt });
        return sendJson(res, 200, { message: { ...existing, text, editedAt } });
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  return false;
}
