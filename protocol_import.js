// protocol_import.js -- builds an app Training Protocol from a student's old
// custom-program page on custom.pacificrimathletics.com (WordPress/Elementor).
// Same parser + layout as the one-time Nov 8 import of everyone's pages, now
// on the server so a NEW student's program can be built automatically (see
// autoBuildProtocolFromCustomPage in chat_backend.js).
//
// protocol_import_map.json: Vimeo id -> the matching Drive copy of that video
// ({ id, name }), built during the original import. A page video missing from
// it can't be shown in the app and is reported back as "missing".
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const WP = "https://custom.pacificrimathletics.com/wp-json/wp/v2/pages";
let videoMap = null;
export function loadVideoMap() {
  if (!videoMap) {
    try { videoMap = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "protocol_import_map.json"), "utf8")); }
    catch { videoMap = {}; }
  }
  return videoMap;
}

const VIMEO_RE = /vimeo\.com[\\/]+(?:video[\\/]+)?(\d{6,})/;
const clean = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/<[^>]*$/, "")
    .replace(/^[^<]*?>/, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&#8216;|&#039;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export function parsePage(html) {
  const parts = html.split(/data-widget_type="/).slice(1);
  const widgets = parts.map((p) => {
    const type = p.slice(0, p.indexOf(".default"));
    const own = p.split(/<div class="elementor-element /)[0];
    const vid = (own.match(VIMEO_RE) || p.slice(0, 4000).match(VIMEO_RE) || [])[1];
    return { type, text: clean(own.slice(own.indexOf(">") + 1)), vimeoId: type === "video" && vid ? Number(vid) : null };
  });
  const sections = [];
  let section = { title: "", items: [] };
  let item = null;
  const isDay = (t) => /^(day|week)\s*\d+/i.test(t);
  for (const w of widgets) {
    if (w.type === "heading") {
      if (!w.text) continue;
      if (isDay(w.text)) {
        if (section.items.length || section.title) sections.push(section);
        section = { title: w.text, items: [] };
        item = null;
      } else {
        item = { name: w.text, text: "", vimeoId: null };
        section.items.push(item);
      }
    } else if (w.type === "text-editor") {
      if (item) item.text = [item.text, w.text].filter(Boolean).join("\n");
      else section.intro = [section.intro, w.text].filter(Boolean).join("\n");
    } else if (w.type === "video" && w.vimeoId) {
      if (item && !item.vimeoId) item.vimeoId = w.vimeoId;
      else section.items.push((item = { name: "", text: "", vimeoId: w.vimeoId }));
    }
  }
  sections.push(section);
  return sections.filter((s) => s.items.length);
}

const DAY_RE = /^(day|week)\s*\d+/i;
const SOFT_DAY_RE = /\bday\b|^workout\s*\d+|^session\s*\d+/i;
const isPageTitle = (it) => !it.vimeoId && /custom (program|workout)/i.test(it.name);

// Day steps chained across; each day's moves stacked below; each video's
// instructions as its right-hand note -- same layout as hand-built protocols.
export function buildSteps(sections, driveMap = loadVideoMap()) {
  const flat = [];
  const hasDays = sections.some((s) => DAY_RE.test(s.title));
  for (const s of sections) {
    if (hasDays && DAY_RE.test(s.title)) flat.push({ dayBreak: true, title: s.title, intro: s.intro });
    for (const it of s.items) {
      if (isPageTitle(it)) continue;
      if (!hasDays && !it.vimeoId && SOFT_DAY_RE.test(it.name.split("\n")[0])) flat.push({ dayBreak: true, title: it.name, intro: it.text });
      else flat.push(it);
    }
  }
  const firstBreak = flat.findIndex((x) => x.dayBreak);
  const warm = firstBreak === -1 ? [] : flat.slice(0, firstBreak);
  const rest = firstBreak === -1 ? [{ dayBreak: true, title: "" }, ...flat] : flat.slice(firstBreak);
  const days = [];
  for (const x of rest) {
    if (x.dayBreak) days.push({ title: x.title, intro: x.intro, items: [] });
    else days[days.length - 1].items.push(x);
  }
  if (warm.length) days[0].items = [...warm.map((w, k) => ({ ...w, warm: k === 0 })), ...days[0].items];

  const steps = [];
  const missing = [];
  let prevDay = null;
  days.forEach((day, i) => {
    const dayStep = { id: randomUUID(), parentId: prevDay, isBranchRoot: false, type: "day", dayNumber: i + 1 };
    steps.push(dayStep);
    prevDay = dayStep.id;
    let prev = null;
    const add = (step) => {
      const s = { id: randomUUID(), parentId: prev ?? dayStep.id, isBranchRoot: true, ...step };
      steps.push(s);
      prev = s.id;
      return s.id;
    };
    const head = [!DAY_RE.test(day.title) ? day.title : "", day.intro].filter(Boolean).join("\n\n");
    if (head) add({ type: "text", content: head });
    for (const it of day.items) {
      const caption = [it.warm ? "WARM UP - do this before each day." : "", it.name, it.text].filter(Boolean).join("\n\n");
      const drive = it.vimeoId ? driveMap[it.vimeoId] : null;
      if (it.vimeoId && !drive) missing.push({ vimeoId: it.vimeoId, name: (it.name || "").split("\n")[0] });
      if (drive) {
        const vid = add({ type: "video", driveFileId: drive.id, name: drive.name || `${it.name}.mp4`, ...(it.name ? { moveLabel: it.name.split("\n")[0] } : {}) });
        if (caption) steps.push({ id: randomUUID(), parentId: vid, isBranchRoot: false, type: "text", content: caption });
      } else if (caption) add({ type: "text", content: caption });
    }
  });
  return { steps, missing, days: days.length };
}

// The student's current custom-program page: title has their first AND last
// name, isn't marked DONOTUSE; a "NEW" page wins, then the most recently edited.
export async function findCustomProgramPage(first, last) {
  const f = String(first || "").trim().toUpperCase(), l = String(last || "").trim().toUpperCase();
  if (!f || !l) return null;
  const r = await fetch(`${WP}?search=${encodeURIComponent(l)}&per_page=50&_fields=id,link,title,modified`);
  if (!r.ok) throw new Error(`custom site search failed (${r.status})`);
  const pages = await r.json();
  const words = (t) => t.replace(/&[^;]+;/g, " ").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const cands = pages.filter((p) => {
    const w = words(p.title?.rendered || "");
    const title = w.join(" ");
    if (/DONOTUSE|DO NOT USE/.test(title)) return false;
    if (!/CUSTOM|PROGRAM|WORKOUT/.test(title)) return false;
    const lastOk = l.split(/\s+/).every((part) => w.includes(part.replace(/[^A-Z0-9]/g, "")));
    const firstOk = w.some((x) => x === f || x.startsWith(f) || f.startsWith(x) && x.length >= 3);
    return lastOk && firstOk;
  });
  cands.sort((a, b) => (/\bNEW\b/i.test(b.title.rendered) - /\bNEW\b/i.test(a.title.rendered)) || String(b.modified).localeCompare(String(a.modified)));
  return cands[0] || null;
}

export async function buildFromCustomPage(first, last) {
  const page = await findCustomProgramPage(first, last);
  if (!page) return { found: false };
  const c = await (await fetch(`${WP}/${page.id}?_fields=content,title,link`)).json();
  const { steps, missing, days } = buildSteps(parsePage(c.content?.rendered || ""));
  return { found: true, pageTitle: (c.title?.rendered || "").replace(/&[^;]+;/g, " "), sourceUrl: c.link || page.link, steps, missing, days };
}
