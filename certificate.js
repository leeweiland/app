// Level-up certificate -- Lee's own "CERTIFICATE OF ADVANCEMENT" (Google
// Slides "CERTIFICATE OF ADVANCEMENT BLANK", exported once to
// assets/certificate/template.jpg at 2160x1728) with the blanks filled in:
// name, level, element and date, written on its lines in Italianno, the
// script font the template itself uses. Sent by the CRM's "8 CERTIFICATE"
// flow to the student's app group, SMS and email (Lee, 2026-11-21).
//
// Drawn as SVG over the template image and rendered with resvg; the output
// is JPEG (via ffmpeg) so it stays small enough for picture texts.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import ffmpegPath from "ffmpeg-static";

const HERE = dirname(fileURLToPath(import.meta.url));
const asset = (p) => join(HERE, "assets", p);
const FONT_FILES = [asset("fonts/italianno-400-normal.ttf")];
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let bgUri = null;
const background = () => bgUri || (bgUri = "data:image/jpeg;base64," + readFileSync(asset("certificate/template.jpg")).toString("base64"));

const W = 2160, H = 1728;
const LINE_X = 1077;                       // centre of the blank lines
const LINES = { name: 640, level: 790, element: 941, date: 1092 }; // their y (template pixels)
const FIT_W = 760;                         // longest a fill may run (the lines are 538 wide)

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
// "HANDSTAND" + "4" -> "HANDSTAND · LEVEL 4" (CRM tokens / captions); Foundation is done/not done.
export function levelLabel(category, level) {
  const cat = String(category || "").toUpperCase();
  if (cat === "FOUNDATION") return "FOUNDATION COMPLETE";
  return `${cat} · LEVEL ${level}`;
}
function ordinalDate(d) {
  const parts = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Anchorage" }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const day = Number(get("day")), sfx = (day % 100 >= 11 && day % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
  return `${get("month")} ${day}${sfx}, ${get("year")}`;
}
// Italianno is narrow (~0.36 em per character); shrink a long fill to the line.
const fitSize = (text, size) => Math.min(size, Math.floor(FIT_W / Math.max(1, String(text).length * 0.36)));

export function certificateSvg({ name, category, level, date }) {
  const cat = String(category || "").toUpperCase();
  const fills = {
    name: name,
    level: cat === "FOUNDATION" ? "Foundation" : String(level ?? ""),
    element: titleCase(cat),
    date: date || ordinalDate(new Date()),
  };
  // Sized to sit between the line and the printed words above it (~75px of room).
  const sizes = { name: 88, level: 86, element: 84, date: 80 };
  const text = (k) => {
    const size = fitSize(fills[k], sizes[k]);
    return `<text x="${LINE_X}" y="${LINES[k] - 9}" text-anchor="middle" font-family="Italianno" font-size="${size}" fill="#111">${esc(fills[k])}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image x="0" y="0" width="${W}" height="${H}" xlink:href="${background()}"/>
  ${["name", "level", "element", "date"].map(text).join("\n  ")}
</svg>`;
}

// JPEG bytes (quality ~90), 2160x1728.
export function renderCertificate(opts) {
  const png = new Resvg(certificateSvg(opts), { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Italianno" } }).render().asPng();
  const base = join(tmpdir(), "cert-" + randomBytes(6).toString("hex"));
  writeFileSync(base + ".png", png);
  try {
    execFileSync(ffmpegPath, ["-v", "error", "-y", "-i", base + ".png", "-q:v", "3", base + ".jpg"]);
    return readFileSync(base + ".jpg");
  } finally {
    try { unlinkSync(base + ".png"); } catch {}
    try { unlinkSync(base + ".jpg"); } catch {}
  }
}
