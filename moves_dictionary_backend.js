// moves_dictionary_backend.js — "Powerbatics Training Videos", a searchable
// move library. The video LIST is live: every request re-derives it from
// whichever Drive folder is currently configured (Admin panel > Chat
// Configuration > Powerbatics Videos Drive Folder ID, stored in
// chat_admin_config.json alongside chat_backend.js's other settings) —
// changing that folder changes what shows here immediately, no separate
// resync step. moves_dictionary.json is now pure enrichment data: any
// curated entry whose driveFileId still appears in the live folder gets its
// hand-written name/description/category/tags; anything else in the folder
// still shows up, just with reasonable name-from-filename defaults, so a
// newly added clip isn't invisible while waiting to be described by hand.
// A curated entry whose file is no longer in the current folder simply
// doesn't appear — the folder, not the JSON, is the source of truth for
// which videos exist right now.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { request as httpsRequest } from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICT_FILE = "moves_dictionary.json";
const CONFIG_FILE = "chat_admin_config.json";
const DEFAULT_FOLDER_ID = "1Es9fbvFRx7EuFiZu9t-X8pmZXGigf_wX";

function readJson(file, fallback) {
  const p = join(__dirname, file);
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback; } catch { return fallback; }
}
function writeJson(file, data) {
  writeFileSync(join(__dirname, file), JSON.stringify(data, null, 2), "utf8");
}

function getConfiguredFolderId() {
  const cfg = readJson(CONFIG_FILE, {});
  return cfg.powerbaticsVideosFolderId || DEFAULT_FOLDER_ID;
}

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

// Mirrors chat_backend.js's getAllDescendantFolderIds — kept as its own
// small copy rather than a cross-module import, since this module already
// reads chat_backend.js's config file directly the same lightweight way.
async function getAllDescendantFolderIds(rootId, accessToken) {
  const all = [rootId];
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length && depth < 8) {
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
  return all;
}

// "cat_hang-dynacombo Freerun.mp4" -> "Cat Hang Dynacombo Freerun"
function nameFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(" ") || filename;
}

let liveListCache = { key: null, moves: null, expiresAt: 0 };

async function fetchLiveMoves() {
  const folderId = getConfiguredFolderId();
  if (liveListCache.key === folderId && liveListCache.expiresAt > Date.now()) return liveListCache.moves;

  const curated = readJson(DICT_FILE, []);
  const curatedByFileId = new Map(curated.map(m => [m.driveFileId, m]));

  const accessToken = await getDriveAccessToken();
  const folderIds = await getAllDescendantFolderIds(folderId, accessToken);
  const parentsClause = folderIds.map(id => `'${id}' in parents`).join(" or ");
  const q = `(${parentsClause}) and mimeType contains 'video/' and trashed = false`;
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1000`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const d = await r.json();
  const files = d.files || [];

  const moves = files.map((f, i) => {
    const curatedEntry = curatedByFileId.get(f.id);
    if (curatedEntry) return curatedEntry;
    return {
      id: "pb-live-" + f.id,
      name: nameFromFilename(f.name),
      category: "General",
      driveFileId: f.id,
      description: "",
      tags: [],
    };
  });

  liveListCache = { key: folderId, moves, expiresAt: Date.now() + 60 * 1000 };
  return moves;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
  return true;
}

export async function handleMovesDictionaryRequest(req, res, url) {
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/moves-dictionary/moves") {
    let moves;
    try {
      moves = await fetchLiveMoves();
    } catch (e) {
      // Drive unreachable/misconfigured folder — fall back to whatever was
      // last hand-curated rather than showing nothing at all.
      moves = readJson(DICT_FILE, []);
    }
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();
    const category = url.searchParams.get("category");
    let results = moves;
    if (category) results = results.filter(m => m.category === category);
    if (q) {
      results = results.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.tags.some(t => t.toLowerCase().includes(q))
      );
    }
    const categories = Array.from(new Set(moves.map(m => m.category))).sort();
    return sendJson(res, 200, { moves: results, categories });
  }

  const mediaMatch = p.match(/^\/api\/moves-dictionary\/media\/([^/]+)$/);
  if (mediaMatch && req.method === "GET") {
    const fileId = mediaMatch[1];
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

  return false;
}
