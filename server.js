import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { handleChatRequest } from "./chat_backend.js";
import { handleBodyAnalysisRequest } from "./body_analysis_backend.js";
import { handleMovesDictionaryRequest } from "./moves_dictionary_backend.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack ?? err);
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (await handleChatRequest(req, res, url)) return;
  if (await handleBodyAnalysisRequest(req, res, url)) return;
  if (await handleMovesDictionaryRequest(req, res, url)) return;

  // Serve static files — strip /chat-app/ prefix if present
  let pathname = url.pathname.replace(/^\/chat-app\//, "/");
  let filePath = join(__dirname, pathname === "/" ? "login.html" : pathname);
  if (!existsSync(filePath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  // No Cache-Control here meant no explicit signal either way — WKWebView's
  // NSURLCache was heuristically caching html/js/css across app relaunches,
  // so a Railway deploy wouldn't actually reach the phone until the OS
  // evicted the cache on its own schedule, no matter how many times the app
  // itself was force-quit and reopened.
  const noCacheExts = [".html", ".js", ".css"];
  if (noCacheExts.includes(ext)) res.setHeader("Cache-Control", "no-store");
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(filePath));
}).listen(PORT, () => console.log(`Server running on port ${PORT}`));
