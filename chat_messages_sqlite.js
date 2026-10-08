// chat_messages_sqlite.js — replaces chat_messages.json as the message
// store. The JSON-file approach (readJson/writeJson: read + JSON.parse the
// WHOLE file, then re-filter the WHOLE array per conversation) got
// progressively slower as real message history piled up -- GET
// /api/chat/conversations (polled every 3s by every open sidebar) was
// doing one full pass over every message in the app, per conversation,
// per poll, per connected user. Same root cause and same fix crm-app
// already shipped for its own Inbox sidebar (see crm-app/sqlite_inbox.js's
// comment: "~2.4-7s per request" on JSON, "~0-150ms" on SQLite) --
// node:sqlite (built into Node, no new dependency), one indexed table,
// named query functions instead of array scans.
//
// chat_messages.json is left on disk, untouched, as a snapshot/backup --
// nothing reads or writes it anymore once this module's one-time backfill
// (see migrateFromJsonIfNeeded below) has run. Deliberately NOT importing
// DATA_DIR/readJson from chat_backend.js here (that would be a circular
// import, since chat_backend.js imports this module) -- both are
// trivially recomputed locally instead, same reasoning crm-app's own
// sqlite_inbox.js gives for not importing back from its own callers.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const JSON_SOURCE_PATH = join(DATA_DIR, "chat_messages.json");
const DB_PATH = join(DATA_DIR, "chat_messages.db");

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
// Same two PRAGMAs crm-app's sqlite_inbox.js adopted after confirming live
// production lock contention: busy_timeout so a request that arrives
// mid-write waits instead of throwing "database is locked", WAL so
// concurrent readers (several requests at once, which this app genuinely
// has) don't block behind a single in-flight write.
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    conversationId TEXT NOT NULL,
    senderId TEXT NOT NULL,
    type TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    text TEXT,
    driveFileId TEXT,
    mimeType TEXT,
    name TEXT,
    driveFileName TEXT,
    feedGroupId TEXT,
    forwarded INTEGER,
    replyToId TEXT,
    videoNotes TEXT,
    reactions TEXT,
    deliveredTo TEXT,
    editedAt TEXT,
    googleEventId TEXT,
    googleEventLink TEXT,
    googleEventIds TEXT,
    googleEventLinks TEXT,
    startISO TEXT,
    durationMinutes INTEGER,
    timezone TEXT,
    isGym INTEGER,
    clientIds TEXT,
    callId TEXT,
    callOutcome TEXT,
    durationSeconds INTEGER
  );
  -- conversationId+createdAt covers every per-conversation range/filter
  -- query (thread page, search, media list, coach-stats date range); seq
  -- is the real, clock-skew-immune ordering key (see migrateFromJsonIfNeeded's
  -- comment on why "ORDER BY seq" replaces "trust array push order").
  CREATE INDEX IF NOT EXISTS idx_messages_convo_created ON messages(conversationId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_messages_convo_type ON messages(conversationId, type);
  CREATE INDEX IF NOT EXISTS idx_messages_drivefileid ON messages(driveFileId);
`);

// First schema change since this table was created -- CREATE TABLE IF NOT
// EXISTS above is a no-op against an already-existing DB file (the normal
// case on every real deploy), so a brand-new column needs its own explicit,
// idempotent ALTER TABLE. posterFileId holds the Drive file id of a
// video message's server-generated first-frame thumbnail (see
// chat_backend.js's video-message upload handler) -- NULL for every
// message sent before this existed, same as any other optional column here.
const hasPosterColumn = db.prepare("PRAGMA table_info(messages)").all().some(c => c.name === "posterFileId");
if (!hasPosterColumn) db.exec("ALTER TABLE messages ADD COLUMN posterFileId TEXT");

// ── One-time backfill from the old JSON file ────────────────────────────
// Runs at most once per deployment: if the table is already populated
// (any later boot, or a fresh Volume that already has the .db file), this
// is a single cheap COUNT(*) and nothing else happens. chat_messages.json
// itself is never deleted or written to by this module -- it just quietly
// stops being read once this has run, left in place as a point-in-time
// backup. seq is assigned in the JSON array's own original order, which is
// exactly the order every existing route already trusted implicitly (see
// chat_backend.js's old "convoMsgs[convoMsgs.length-1]" / ".slice(-limit)"
// patterns this migration replaces) -- so history reorders exactly zero
// messages relative to how they rendered before this migration.
function migrateFromJsonIfNeeded() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  if (existing > 0) return;
  if (!existsSync(JSON_SOURCE_PATH)) return;
  let oldMessages;
  try { oldMessages = JSON.parse(readFileSync(JSON_SOURCE_PATH, "utf8")); } catch { return; }
  if (!Array.isArray(oldMessages) || !oldMessages.length) return;

  const insert = db.prepare(`
    INSERT INTO messages
      (id, conversationId, senderId, type, createdAt, text, driveFileId, mimeType, name, driveFileName,
       feedGroupId, forwarded, replyToId, videoNotes, reactions, deliveredTo, editedAt,
       googleEventId, googleEventLink, googleEventIds, googleEventLinks,
       startISO, durationMinutes, timezone, isGym, clientIds, callId, callOutcome, durationSeconds)
    VALUES
      (:id, :conversationId, :senderId, :type, :createdAt, :text, :driveFileId, :mimeType, :name, :driveFileName,
       :feedGroupId, :forwarded, :replyToId, :videoNotes, :reactions, :deliveredTo, :editedAt,
       :googleEventId, :googleEventLink, :googleEventIds, :googleEventLinks,
       :startISO, :durationMinutes, :timezone, :isGym, :clientIds, :callId, :callOutcome, :durationSeconds)
  `);
  console.log(`[chat_messages_sqlite] backfilling ${oldMessages.length} messages from chat_messages.json...`);
  db.exec("BEGIN");
  try {
    for (const m of oldMessages) {
      // A hand-edited or corrupted row missing the handful of truly
      // required fields would otherwise abort the whole backfill (NOT
      // NULL violation) partway through -- skip just that one row instead.
      if (!m || !m.id || !m.conversationId || !m.senderId || !m.type || !m.createdAt) {
        console.error("[chat_messages_sqlite] skipping malformed row during backfill:", JSON.stringify(m).slice(0, 200));
        continue;
      }
      insert.run(toRow(m));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  console.log("[chat_messages_sqlite] backfill complete.");
}

// ── JS object <-> SQLite row ─────────────────────────────────────────────
function toRow(m) {
  return {
    id: m.id, conversationId: m.conversationId, senderId: m.senderId, type: m.type, createdAt: m.createdAt,
    text: m.text ?? null,
    driveFileId: m.driveFileId ?? null, mimeType: m.mimeType ?? null, name: m.name ?? null, driveFileName: m.driveFileName ?? null,
    posterFileId: m.posterFileId ?? null,
    feedGroupId: m.feedGroupId ?? null,
    forwarded: m.forwarded ? 1 : null,
    replyToId: m.replyToId ?? null,
    videoNotes: m.videoNotes ? JSON.stringify(m.videoNotes) : null,
    reactions: m.reactions ? JSON.stringify(m.reactions) : null,
    deliveredTo: m.deliveredTo ? JSON.stringify(m.deliveredTo) : null,
    editedAt: m.editedAt ?? null,
    googleEventId: m.googleEventId ?? null, googleEventLink: m.googleEventLink ?? null,
    googleEventIds: m.googleEventIds ? JSON.stringify(m.googleEventIds) : null,
    googleEventLinks: m.googleEventLinks ? JSON.stringify(m.googleEventLinks) : null,
    startISO: m.startISO ?? null, durationMinutes: m.durationMinutes ?? null, timezone: m.timezone ?? null,
    isGym: m.isGym === undefined ? null : (m.isGym ? 1 : 0),
    clientIds: m.clientIds ? JSON.stringify(m.clientIds) : null,
    callId: m.callId ?? null, callOutcome: m.callOutcome ?? null, durationSeconds: m.durationSeconds ?? null,
  };
}
// Inverse of toRow -- a column that was never set on the original message
// (NULL) comes back as undefined, not null, so JSON.stringify drops it
// from the HTTP response exactly like an absent object key would (this is
// what makes "the field is just missing until first use" -- reactions,
// deliveredTo, editedAt, forwarded, etc. -- behave identically to before).
function rowToMessage(row) {
  if (!row) return null;
  const m = {
    id: row.id, conversationId: row.conversationId, senderId: row.senderId, type: row.type, createdAt: row.createdAt,
    text: row.text ?? undefined,
    driveFileId: row.driveFileId ?? undefined, mimeType: row.mimeType ?? undefined, name: row.name ?? undefined, driveFileName: row.driveFileName ?? undefined,
    posterFileId: row.posterFileId ?? undefined,
    feedGroupId: row.feedGroupId ?? undefined,
    forwarded: row.forwarded ? true : undefined,
    replyToId: row.replyToId ?? undefined,
    videoNotes: row.videoNotes ? JSON.parse(row.videoNotes) : undefined,
    reactions: row.reactions ? JSON.parse(row.reactions) : undefined,
    deliveredTo: row.deliveredTo ? JSON.parse(row.deliveredTo) : undefined,
    editedAt: row.editedAt ?? undefined,
    googleEventId: row.googleEventId ?? undefined, googleEventLink: row.googleEventLink ?? undefined,
    googleEventIds: row.googleEventIds ? JSON.parse(row.googleEventIds) : undefined,
    googleEventLinks: row.googleEventLinks ? JSON.parse(row.googleEventLinks) : undefined,
    startISO: row.startISO ?? undefined, durationMinutes: row.durationMinutes ?? undefined, timezone: row.timezone ?? undefined,
    isGym: row.isGym === null ? undefined : !!row.isGym,
    clientIds: row.clientIds ? JSON.parse(row.clientIds) : undefined,
    callId: row.callId ?? undefined, callOutcome: row.callOutcome ?? undefined, durationSeconds: row.durationSeconds ?? undefined,
  };
  return m;
}

const JSON_COLUMNS = new Set(["videoNotes", "reactions", "deliveredTo", "googleEventIds", "googleEventLinks", "clientIds"]);
const BOOL_COLUMNS = new Set(["forwarded", "isGym"]);

const INSERT_COLUMNS = [
  "id", "conversationId", "senderId", "type", "createdAt", "text", "driveFileId", "mimeType", "name", "driveFileName",
  "posterFileId",
  "feedGroupId", "forwarded", "replyToId", "videoNotes", "reactions", "deliveredTo", "editedAt",
  "googleEventId", "googleEventLink", "googleEventIds", "googleEventLinks",
  "startISO", "durationMinutes", "timezone", "isGym", "clientIds", "callId", "callOutcome", "durationSeconds",
];
const insertStmt = db.prepare(`
  INSERT INTO messages (${INSERT_COLUMNS.join(", ")})
  VALUES (${INSERT_COLUMNS.map(c => ":" + c).join(", ")})
`);

export function insertMessage(m) {
  insertStmt.run(toRow(m));
  return m;
}

// Used by the multi-file attach send -- one transaction for the whole
// batch instead of one autocommit per file (crm-app's sqlite_inbox.js
// measured a ~140s stall from exactly this mistake at its own scale).
export function insertMessages(msgs) {
  if (!msgs.length) return msgs;
  db.exec("BEGIN");
  try {
    for (const m of msgs) insertStmt.run(toRow(m));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return msgs;
}

const getByIdStmt = db.prepare("SELECT * FROM messages WHERE id = ?");
export function getMessageById(id) {
  return rowToMessage(getByIdStmt.get(id));
}

// Generic partial update -- covers delivered-to stamping, reaction
// toggling, and text-edit, the only three places that mutate an
// already-sent message's fields in place.
export function updateMessageFields(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = :${k}`).join(", ");
  const params = { id };
  for (const k of keys) {
    const v = patch[k];
    params[k] = JSON_COLUMNS.has(k) ? (v == null ? null : JSON.stringify(v))
      : BOOL_COLUMNS.has(k) ? (v == null ? null : (v ? 1 : 0))
      : (v === undefined ? null : v);
  }
  db.prepare(`UPDATE messages SET ${sets} WHERE id = :id`).run(params);
}

export function deleteMessageById(id) {
  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
}

export function deleteMessagesForConversation(conversationId) {
  db.prepare("DELETE FROM messages WHERE conversationId = ?").run(conversationId);
}

// Delete-user cascade: messages in a DM being removed entirely, OR any
// message (in a surviving group) authored by the removed user -- exactly
// chat_backend.js's old `!dmIdsToRemove.includes(m.conversationId) &&
// m.senderId !== targetId` keep-filter, inverted into a delete.
export function deleteMessagesForUserRemoval(dmIdsToRemove, targetUserId) {
  db.exec("BEGIN");
  try {
    if (dmIdsToRemove.length) {
      const placeholders = dmIdsToRemove.map(() => "?").join(", ");
      db.prepare(`DELETE FROM messages WHERE conversationId IN (${placeholders})`).run(...dmIdsToRemove);
    }
    db.prepare("DELETE FROM messages WHERE senderId = ?").run(targetUserId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Ascending-order page, same shape GET /messages has always returned:
// the `limit` most recent messages (optionally strictly before `before`),
// oldest-first. ORDER BY seq (not createdAt) is the real fix here -- seq
// is a strictly monotonic insertion counter, immune to two messages
// sharing a millisecond (the old code sidestepped that by staggering
// createdAt by +i ms on batch sends; seq makes that stagger unnecessary,
// though harmless to leave in place).
const pageStmt = db.prepare("SELECT * FROM messages WHERE conversationId = :conversationId ORDER BY seq DESC LIMIT :limit");
const pageBeforeStmt = db.prepare("SELECT * FROM messages WHERE conversationId = :conversationId AND createdAt < :before ORDER BY seq DESC LIMIT :limit");
export function getConversationMessages(conversationId, { before, limit = 50 } = {}) {
  const rows = before
    ? pageBeforeStmt.all({ conversationId, before, limit })
    : pageStmt.all({ conversationId, limit });
  return rows.reverse().map(rowToMessage);
}

// Sidebar's "last message per conversation" -- one indexed query for every
// conversation the viewer is in, instead of one full-array filter per
// conversation. ROW_NUMBER()/PARTITION BY needs SQLite 3.25+; node:sqlite's
// bundled version is well past that.
export function getLastMessages(conversationIds) {
  const map = new Map();
  if (!conversationIds.length) return map;
  const placeholders = conversationIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY conversationId ORDER BY seq DESC) AS rn
      FROM messages WHERE conversationId IN (${placeholders})
    ) WHERE rn = 1
  `).all(...conversationIds);
  for (const row of rows) map.set(row.conversationId, rowToMessage(row));
  return map;
}

const unreadCountStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE conversationId = :conversationId AND senderId != :viewerId AND createdAt > :sinceISO"
);
const unreadCountAllStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE conversationId = :conversationId AND senderId != :viewerId"
);
export function getUnreadCount(conversationId, viewerId, sinceISO) {
  return (sinceISO ? unreadCountStmt.get({ conversationId, viewerId, sinceISO }) : unreadCountAllStmt.get({ conversationId, viewerId })).n;
}

const searchStmt = db.prepare(
  "SELECT * FROM messages WHERE conversationId = :conversationId AND type = 'text' AND LOWER(text) LIKE :q ORDER BY seq ASC"
);
export function searchConversationText(conversationId, query) {
  return searchStmt.all({ conversationId, q: `%${query.toLowerCase()}%` }).map(rowToMessage);
}

const mediaStmt = db.prepare(
  "SELECT * FROM messages WHERE conversationId = :conversationId AND type IN ('image', 'video') ORDER BY seq ASC"
);
export function getConversationMedia(conversationId) {
  return mediaStmt.all({ conversationId }).map(rowToMessage);
}

// Media-streaming-proxy / favorites-save auth checks: "is this Drive file
// actually attached to a message I can see?" typesIn narrows to
// image/video for the favorites check; the media-proxy check has no type
// filter at all (any attachment type counts).
export function findMessageByDriveFileId(driveFileId, { typesIn } = {}) {
  const row = typesIn && typesIn.length
    ? db.prepare(`SELECT * FROM messages WHERE driveFileId = ? AND type IN (${typesIn.map(() => "?").join(", ")}) LIMIT 1`).get(driveFileId, ...typesIn)
    : db.prepare("SELECT * FROM messages WHERE driveFileId = ? LIMIT 1").get(driveFileId);
  return rowToMessage(row);
}

// Coach-monthly-stats: every video posted into one of the given (gym
// capture) conversationIds within [monthStart, nextMonthStart).
export function getVideosInMonth(conversationIds, monthStartISO, nextMonthStartISO) {
  if (!conversationIds.length) return [];
  const placeholders = conversationIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT senderId FROM messages
    WHERE type = 'video' AND conversationId IN (${placeholders}) AND createdAt >= ? AND createdAt < ?
  `).all(...conversationIds, monthStartISO, nextMonthStartISO);
}

migrateFromJsonIfNeeded();
