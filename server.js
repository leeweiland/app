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
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
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

  // Serve static files
  let filePath = join(__dirname, url.pathname === "/" ? "login.html" : url.pathname);
  if (!existsSync(filePath)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(filePath));
}).listen(PORT, () => console.log(`Server running on port ${PORT}`));
