// Level-up certificate -- Lee's own "CERTIFICATE OF ADVANCEMENT" (Google
// Slides "CERTIFICATE OF ADVANCEMENT BLANK", exported once to
// assets/certificate/template.jpg at 2160x1728) with the blanks filled in:
// name, level, element and date, written on its lines in Caveat, the
// handwriting font of the template's "Coach Lee" line (Lee: match it). Sent by the CRM's "8 CERTIFICATE"
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
const FONT_FILES = [asset("fonts/caveat-400-normal.ttf")];
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
// Caveat runs ~0.39 em per character; shrink a long fill to the line.
const fitSize = (text, size) => Math.min(size, Math.floor(FIT_W / Math.max(1, String(text).length * 0.39)));

export function certificateSvg({ name, category, level, date }) {
  const cat = String(category || "").toUpperCase();
  const fills = {
    name: name,
    level: cat === "FOUNDATION" ? "Foundation" : String(level ?? ""),
    element: titleCase(cat),
    date: date || ordinalDate(new Date()),
  };
  // Sized to sit between the line and the printed words above it (~75px of room).
  const sizes = { name: 68, level: 66, element: 64, date: 62 };
  const text = (k) => {
    const size = fitSize(fills[k], sizes[k]);
    return `<text x="${LINE_X}" y="${LINES[k] - 9}" text-anchor="middle" font-family="Caveat" font-size="${size}" fill="#111">${esc(fills[k])}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image x="0" y="0" width="${W}" height="${H}" xlink:href="${background()}"/>
  ${["name", "level", "element", "date"].map(text).join("\n  ")}
</svg>`;
}

// JPEG bytes (quality ~90), 2160x1728.
export function renderCertificate(opts) {
  const png = new Resvg(certificateSvg(opts), { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Caveat" } }).render().asPng();
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

// ── Level-up clothing discount card (Lee, 2026-11-21) ────────────────────
// Website shop styling: black with blue/teal glow, neon-lime accents, white
// glowing heading, real product photos (assets/certificate/shop_*.jpg from
// the Shopify store). 1080x1350 (phone/IG portrait). JPEG.
const CARD_FONTS = ["montserrat-400-normal.ttf", "montserrat-700-normal.ttf", "montserrat-800-normal.ttf"].map(f => asset("fonts/" + f));
const jpgUri = (p) => "data:image/jpeg;base64," + readFileSync(asset(p)).toString("base64");
const pngUri = (p) => "data:image/png;base64," + readFileSync(asset(p)).toString("base64");
export function discountCardSvg({ first, code, percent = 30, storeUrl = "pacificrimathletics.com/shop" }) {
  const CW = 1080, CH = 1350, LIME = "rgb(212,255,0)";
  const shop = String(storeUrl || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const prods = [1, 2, 3].map(i => jpgUri(`certificate/shop_${i}.jpg`));
  const codeSize = Math.min(96, Math.floor(820 / Math.max(6, String(code).length * 0.72)));
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
  <defs>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="90"/></filter>
    <filter id="glow" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="c1"><rect x="0" y="0" width="290" height="290" rx="18"/></clipPath>
  </defs>
  <rect width="${CW}" height="${CH}" fill="#000"/>
  <circle cx="120" cy="300" r="300" fill="#2f8fd8" opacity="0.55" filter="url(#blur)"/>
  <circle cx="1000" cy="520" r="260" fill="#0fb8a0" opacity="0.45" filter="url(#blur)"/>
  <circle cx="540" cy="1250" r="300" fill="#1a5fb0" opacity="0.35" filter="url(#blur)"/>
  <image x="${CW / 2 - 150}" y="48" width="300" height="107" xlink:href="${pngUri("pra-logo.png")}"/>
  <text x="${CW / 2}" y="236" text-anchor="middle" font-family="Montserrat Thin" font-weight="800" font-size="64" letter-spacing="4" fill="#fff" filter="url(#glow)">LEVEL UP REWARD</text>
  <text x="${CW / 2}" y="296" text-anchor="middle" font-family="Montserrat Thin" font-weight="400" font-size="34" fill="#d6dde6">${esc(first ? `Congrats ${first}! You passed your level test.` : "You passed your level test.")}</text>
  <text x="${CW / 2}" y="500" text-anchor="middle" font-family="Montserrat Thin" font-weight="800" font-size="200" fill="${LIME}" filter="url(#glow)">${esc(percent)}% OFF</text>
  <text x="${CW / 2}" y="568" text-anchor="middle" font-family="Montserrat Thin" font-weight="700" font-size="40" letter-spacing="3" fill="#fff">YOUR ENTIRE CLOTHING ORDER</text>
  ${prods.map((src, i) => `<g transform="translate(${70 + i * 320} 620)"><rect width="290" height="290" rx="18" fill="#fff"/><image width="290" height="290" preserveAspectRatio="xMidYMid slice" clip-path="url(#c1)" xlink:href="${src}"/></g>`).join("")}
  <rect x="120" y="960" width="840" height="190" rx="22" fill="rgba(212,255,0,0.08)" stroke="${LIME}" stroke-width="4" stroke-dasharray="18 12"/>
  <text x="${CW / 2}" y="1010" text-anchor="middle" font-family="Montserrat Thin" font-weight="700" font-size="28" letter-spacing="6" fill="${LIME}">USE CODE AT CHECKOUT</text>
  <text x="${CW / 2}" y="${1012 + codeSize}" text-anchor="middle" font-family="Montserrat Thin" font-weight="800" font-size="${codeSize}" letter-spacing="6" fill="#fff">${esc(code)}</text>
  <rect x="100" y="1190" width="880" height="76" rx="38" fill="${LIME}"/>
  <text x="${CW / 2}" y="1240" text-anchor="middle" font-family="Montserrat Thin" font-weight="800" font-size="${shop.length > 26 ? 27 : 32}" letter-spacing="1" fill="#000">SHOP: ${esc(shop.toUpperCase())}</text>
  <text x="${CW / 2}" y="1310" text-anchor="middle" font-family="Montserrat Thin" font-weight="400" font-size="24" fill="#9aa6b2">One-time use · Pacific Rim Athletics</text>
</svg>`;
}
export function renderDiscountCard(opts) {
  const png = new Resvg(discountCardSvg(opts), { font: { fontFiles: CARD_FONTS, loadSystemFonts: false, defaultFontFamily: "Montserrat Thin" } }).render().asPng();
  const base = join(tmpdir(), "disc-" + randomBytes(6).toString("hex"));
  writeFileSync(base + ".png", png);
  try {
    execFileSync(ffmpegPath, ["-v", "error", "-y", "-i", base + ".png", "-q:v", "3", base + ".jpg"]);
    return readFileSync(base + ".jpg");
  } finally {
    try { unlinkSync(base + ".png"); } catch {}
    try { unlinkSync(base + ".jpg"); } catch {}
  }
}
