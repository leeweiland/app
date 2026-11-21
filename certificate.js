// Level-up certificate (PNG) -- Lee, 2026-11-21. Sent by the CRM's
// "8 CERTIFICATE" flow to the student's app group, SMS and email when a
// coach moves them up a level on the Levels sheet.
//
// Drawn as SVG and rendered with resvg using fonts bundled in
// assets/fonts (open-source: Cinzel, Montserrat, Great Vibes), so the
// output is the same on every server.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const asset = (p) => join(HERE, "assets", p);
const FONT_FILES = ["cinzel-700-normal.ttf", "montserrat-400-normal.ttf", "montserrat-700-normal.ttf", "montserrat-800-normal.ttf", "great-vibes-400-normal.ttf"].map(f => asset("fonts/" + f));
const dataUri = (p) => existsSync(p) ? "data:image/png;base64," + readFileSync(p).toString("base64") : "";
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const W = 1600, H = 1131;

// "HANDSTAND" + "4" -> "HANDSTAND · LEVEL 4"; Foundation is done/not done.
export function levelLabel(category, level) {
  const cat = String(category || "").toUpperCase();
  if (cat === "FOUNDATION") return "FOUNDATION COMPLETE";
  return `${cat} · LEVEL ${level}`;
}

export function certificateSvg({ name, category, level, program, date }) {
  const cat = String(category || "").toUpperCase();
  const sil = dataUri(asset(`certificate/${cat.toLowerCase().replace(/\s+/g, "_")}.png`));
  const logo = dataUri(asset("pra-logo.png"));
  const sig = dataUri(asset("certificate/signature_white.png"));
  const nameSize = Math.max(76, Math.min(132, Math.floor(1900 / Math.max(8, String(name).length))));
  const label = levelLabel(cat, level);
  const labelSize = label.length > 24 ? 58 : 68;
  const when = date || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Anchorage" });
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#14243a"/><stop offset="0.55" stop-color="#0b1220"/><stop offset="1" stop-color="#05070c"/></radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7e3a1"/><stop offset="0.5" stop-color="#d4a73c"/><stop offset="1" stop-color="#a8781c"/></linearGradient>
    <linearGradient id="mtnA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d3350"/><stop offset="1" stop-color="#0b1424"/></linearGradient>
    <linearGradient id="mtnB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#132338"/><stop offset="1" stop-color="#070b14"/></linearGradient>
    <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <!-- snowy mountain range along the bottom -->
  <g transform="translate(0 150)"><path d="M0 860 L150 760 L240 800 L380 660 L470 720 L560 640 L700 760 L820 690 L930 770 L1060 650 L1160 720 L1270 640 L1400 750 L1500 700 L1600 760 L1600 ${H} L0 ${H} Z" fill="url(#mtnA)" opacity="0.9"/>
  <path d="M150 760 L185 792 L174 789 L166 798 L156 792 L145 802 L136 794 L126 798 L115 792 Z M380 660 L424 700 L410 696 L400 708 L388 700 L374 712 L362 702 L350 707 L336 700 Z M560 640 L608 684 L593 680 L582 693 L569 684 L553 697 L540 686 L527 692 L512 684 Z M820 690 L860 726 L847 722 L838 733 L827 726 L815 737 L804 728 L793 732 L780 726 Z M1060 650 L1104 690 L1090 686 L1080 698 L1068 690 L1054 702 L1042 692 L1030 697 L1016 690 Z M1270 640 L1318 684 L1303 680 L1292 693 L1279 684 L1263 697 L1250 686 L1237 692 L1222 684 Z M1500 700 L1537 734 L1526 731 L1517 741 L1507 734 L1495 744 L1485 736 L1475 740 L1463 734 Z" fill="#dce9f5" opacity="0.55"/></g>
  <path transform="translate(0 90)" d="M0 950 L200 860 L330 910 L480 840 L640 930 L800 850 L980 940 L1130 860 L1290 930 L1450 870 L1600 920 L1600 ${H} L0 ${H} Z" fill="url(#mtnB)"/>
  <!-- borders -->
  <rect x="34" y="34" width="${W - 68}" height="${H - 68}" rx="18" fill="none" stroke="#009bff" stroke-width="4" filter="url(#soft)" opacity="0.95"/>
  <rect x="58" y="58" width="${W - 116}" height="${H - 116}" rx="10" fill="none" stroke="url(#gold)" stroke-width="2"/>
  ${[[58, 58], [W - 58, 58], [58, H - 58], [W - 58, H - 58]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" fill="url(#gold)"/>`).join("")}
  ${logo ? `<image x="${W / 2 - 150}" y="96" width="300" height="107" xlink:href="${logo}"/>` : ""}
  <text x="${W / 2}" y="292" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="58" letter-spacing="10" fill="url(#gold)">CERTIFICATE OF ACHIEVEMENT</text>
  <line x1="${W / 2 - 260}" y1="322" x2="${W / 2 + 260}" y2="322" stroke="url(#gold)" stroke-width="1.5" opacity="0.8"/>
  <text x="${W / 2}" y="392" text-anchor="middle" font-family="Montserrat Thin" font-weight="400" font-size="30" letter-spacing="3" fill="#a9b7c6">THIS CERTIFIES THAT</text>
  <text x="${W / 2}" y="${392 + 40 + nameSize * 0.85}" text-anchor="middle" font-family="Great Vibes" font-size="${nameSize}" fill="#ffffff">${esc(name)}</text>
  <line x1="${W / 2 - 420}" y1="${392 + 70 + nameSize * 0.85}" x2="${W / 2 + 420}" y2="${392 + 70 + nameSize * 0.85}" stroke="#3b4d63" stroke-width="2"/>
  <text x="${W / 2}" y="${392 + 125 + nameSize * 0.85}" text-anchor="middle" font-family="Montserrat Thin" font-weight="400" font-size="30" letter-spacing="3" fill="#a9b7c6">HAS ADVANCED TO</text>
  <text x="${W / 2}" y="${392 + 125 + nameSize * 0.85 + labelSize + 26}" text-anchor="middle" font-family="Montserrat Thin" font-weight="800" font-size="${labelSize}" letter-spacing="4" fill="#009bff" filter="url(#glow)">${esc(label)}</text>
  ${sil ? `<image x="${W - 330}" y="380" width="230" height="300" preserveAspectRatio="xMidYMid meet" opacity="0.9" xlink:href="${sil}" filter="url(#soft)"/>
  <image x="100" y="380" width="230" height="300" preserveAspectRatio="xMidYMid meet" opacity="0.9" xlink:href="${sil}" filter="url(#soft)" transform="translate(430 0) scale(-1 1)"/>` : ""}
  <!-- footer: date left, signature right -->
  <text x="300" y="${H - 175}" text-anchor="middle" font-family="Montserrat Thin" font-weight="700" font-size="30" fill="#ffffff">${esc(when)}</text>
  <line x1="150" y1="${H - 150}" x2="450" y2="${H - 150}" stroke="url(#gold)" stroke-width="1.5"/>
  <text x="300" y="${H - 115}" text-anchor="middle" font-family="Montserrat Thin" font-weight="400" font-size="22" letter-spacing="3" fill="#a9b7c6">DATE</text>
  ${sig ? `<image x="${W - 470}" y="${H - 262}" width="340" height="81" preserveAspectRatio="xMidYMid meet" xlink:href="${sig}"/>` : ""}
  <line x1="${W - 450}" y1="${H - 150}" x2="${W - 150}" y2="${H - 150}" stroke="url(#gold)" stroke-width="1.5"/>
  <text x="${W - 300}" y="${H - 115}" text-anchor="middle" font-family="Montserrat Thin" font-weight="400" font-size="22" letter-spacing="3" fill="#a9b7c6">LEE WEILAND, HEAD COACH</text>
  <text x="${W / 2}" y="${H - 115}" text-anchor="middle" font-family="Montserrat Thin" font-weight="700" font-size="22" letter-spacing="4" fill="#d4ff00">${esc(String(program || "").toUpperCase() ? `PACIFIC RIM ATHLETICS · ${String(program).toUpperCase()}` : "PACIFIC RIM ATHLETICS")}</text>
</svg>`;
}

export function renderCertificatePng(opts) {
  const svg = certificateSvg(opts);
  const r = new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Montserrat Thin" }, fitTo: { mode: "width", value: W } });
  return r.render().asPng();
}
