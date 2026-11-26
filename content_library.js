// Long-form YouTube videos from all three brands (Lee Weiland, Pacific Rim
// Athletics, Powerbatics) for the composer's Videos tab (Lee, 2026-11-26).
// "UULF" + channel id is YouTube's own long-form-only uploads list (no
// Shorts). Read on demand with a 3-hour cache, never polled in the
// background. API key = public videos only. Same file in crm-app.
export const YT_BRANDS = [
  { key: "LW", name: "Lee Weiland", playlist: "UULFx7p3BDXwZipPsqqadBj_XQ" },
  { key: "PRA", name: "Pacific Rim Athletics", playlist: "UULFQvclKQ3IbjuPOGIl43nOuQ" },
  { key: "PB", name: "Powerbatics", playlist: "UULFTgJ5SgNdkmnGbQ_TRkenHA" },
];
const TTL = 3 * 60 * 60 * 1000;
let cache = null, cacheAt = 0, loading = null;

async function fetchBrand(brand, key) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const u = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,status&maxResults=50&playlistId=${brand.playlist}&key=${key}` + (pageToken ? `&pageToken=${pageToken}` : "");
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || `YouTube ${r.status}`);
    for (const it of j.items || []) {
      if (it.status?.privacyStatus && it.status.privacyStatus !== "public") continue;
      const sn = it.snippet || {}, th = sn.thumbnails || {};
      const id = sn.resourceId?.videoId;
      if (!id) continue;
      out.push({
        source: "youtube", brand: brand.key, brandName: brand.name, id,
        title: sn.title || "", publishedAt: sn.publishedAt || "",
        thumb: (th.medium || th.high || th.default || {}).url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        url: `https://youtu.be/${id}`,
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export async function getAllYouTube() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY not set");
  loading = loading || Promise.all(YT_BRANDS.map(b => fetchBrand(b, key).catch(e => { console.error("[content yt]", b.key, e.message); return []; })))
    .then(lists => {
      const all = lists.flat().sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
      if (all.length) { cache = all; cacheAt = Date.now(); }
      return all.length ? all : (cache || []);
    })
    .finally(() => { loading = null; });
  return loading;
}

// Every word of the query has to appear in the title (any order).
export function matchesQuery(text, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const t = String(text || "").toLowerCase();
  return words.every(w => t.includes(w));
}

export async function searchYouTube(q, limit = 60) {
  const all = await getAllYouTube();
  return (q ? all.filter(v => matchesQuery(v.title, q)) : all).slice(0, limit);
}
