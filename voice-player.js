// Voice note player (Lee, 2026-11-26): round play/pause, waveform bars that
// fill in as it plays (tap/drag the waveform to jump), time, 1x/1.5x/2x.
// Same file in chat-app and crm-app. Markup from PRAVoicePlayer.html();
// everything else is document-level, so re-rendered bubbles need no wiring.
// One shared <audio>; the clip is fetched whole into memory on first play,
// so jumping around is instant and works whatever the server supports.
(function () {
  if (window.PRAVoicePlayer) return;
  const css = `
  .vp { display: flex; align-items: center; gap: 10px; min-width: 210px; max-width: 280px; padding: 2px 0; user-select: none; -webkit-user-select: none; }
  .vp-play { width: 38px; height: 38px; flex-shrink: 0; border-radius: 50%; border: 0; background: #fff; color: #0b0b0f; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; box-shadow: 0 0 10px rgba(255,255,255,.35); }
  .vp-play svg { width: 16px; height: 16px; display: block; }
  .vp-play .vp-i-pause { display: none; }
  .vp.playing .vp-play .vp-i-play { display: none; }
  .vp.playing .vp-play .vp-i-pause { display: block; }
  .vp.loading .vp-play { opacity: .6; }
  .vp-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .vp-wave { height: 30px; display: flex; align-items: center; gap: 2px; cursor: pointer; touch-action: none; }
  .vp-wave i { flex: 1; min-width: 2px; border-radius: 2px; background: rgba(255,255,255,.38); transition: background .1s; }
  .vp-wave i.on { background: #fff; box-shadow: 0 0 4px rgba(255,255,255,.6); }
  .vp-meta { display: flex; justify-content: space-between; align-items: center; font-size: .68rem; opacity: .8; font-variant-numeric: tabular-nums; }
  .vp-speed { border: 1px solid rgba(255,255,255,.45); background: transparent; color: inherit; border-radius: 10px; font-size: .64rem; font-weight: 700; padding: 1px 7px; cursor: pointer; }
  .vp-text { margin-top: 6px; font-size: .86rem; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }
  .vp-label { font-size: .62rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; opacity: .65; margin-top: 6px; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (sec) => { sec = Math.max(0, Math.round(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const BARS = 40;
  function barsHtml(peaks) {
    let p = Array.isArray(peaks) && peaks.length ? peaks : null;
    if (!p) p = Array.from({ length: BARS }, (_, i) => 0.25 + 0.2 * Math.abs(Math.sin(i * 1.7)));
    // resample to BARS
    const out = [];
    for (let i = 0; i < BARS; i++) out.push(p[Math.min(p.length - 1, Math.floor(i * p.length / BARS))]);
    return out.map(v => `<i style="height:${Math.round(Math.max(0.1, Math.min(1, v)) * 100)}%"></i>`).join('');
  }
  // { src, peaks?, peaksUrl?, duration?, transcript?, label? }
  function html(o) {
    return `<div class="vp" data-src="${esc(o.src)}"${o.peaksUrl && !o.peaks ? ` data-peaks-url="${esc(o.peaksUrl)}"` : ''} data-dur="${Number(o.duration) || 0}">
      <button type="button" class="vp-play" aria-label="Play voice note"><svg class="vp-i-play" viewBox="0 0 16 16"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg><svg class="vp-i-pause" viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg></button>
      <div class="vp-mid"><div class="vp-wave">${barsHtml(o.peaks)}</div><div class="vp-meta"><span class="vp-time">${fmt(o.duration)}</span><button type="button" class="vp-speed">1x</button></div></div>
    </div>${o.transcript ? `${o.label ? `<div class="vp-label">${esc(o.label)}</div>` : ''}<div class="vp-text">${esc(o.transcript)}</div>` : ''}`;
  }
  // Fills in waveforms whose peaks live in a separate file (CRM).
  const peaksCache = new Map();
  function hydrate(root) {
    (root || document).querySelectorAll('.vp[data-peaks-url]').forEach(el => {
      const url = el.dataset.peaksUrl;
      el.removeAttribute('data-peaks-url');
      const apply = (d) => {
        if (!d) return;
        if (Array.isArray(d.peaks)) el.querySelector('.vp-wave').innerHTML = barsHtml(d.peaks);
        if (d.duration && !Number(el.dataset.dur)) { el.dataset.dur = d.duration; el.querySelector('.vp-time').textContent = fmt(d.duration); }
      };
      if (peaksCache.has(url)) { apply(peaksCache.get(url)); return; }
      fetch(url).then(r => r.ok ? r.json() : null).then(d => { peaksCache.set(url, d); apply(d); }).catch(() => {});
    });
  }
  new MutationObserver(() => { if (document.querySelector('.vp[data-peaks-url]')) hydrate(document); })
    .observe(document.documentElement, { childList: true, subtree: true });

  const audio = new Audio();
  audio.preload = 'auto';
  let curEl = null, curSrc = '', rate = 1;
  const blobs = new Map(); // src -> blob url
  const elFor = () => (curEl && curEl.isConnected) ? curEl : (curSrc ? document.querySelector(`.vp[data-src="${CSS.escape(curSrc)}"]`) : null);
  function paint() {
    const el = elFor();
    if (!el) return;
    curEl = el;
    const dur = audio.duration && isFinite(audio.duration) ? audio.duration : Number(el.dataset.dur) || 0;
    const f = dur ? audio.currentTime / dur : 0;
    const bars = el.querySelectorAll('.vp-wave i');
    const on = Math.round(f * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < on));
    el.querySelector('.vp-time').textContent = audio.paused && audio.currentTime === 0 ? fmt(dur) : fmt(audio.currentTime);
    el.classList.toggle('playing', !audio.paused && !audio.ended);
  }
  ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'seeked'].forEach(ev => audio.addEventListener(ev, paint));
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
  async function load(el) {
    const src = el.dataset.src;
    const prev = curEl;
    if (prev && prev !== el) { prev.classList.remove('playing'); prev.querySelectorAll('.vp-wave i.on').forEach(b => b.classList.remove('on')); }
    curEl = el;
    if (curSrc === src && audio.src) return true;
    curSrc = src;
    let url = blobs.get(src);
    if (!url) {
      el.classList.add('loading');
      try {
        const r = await fetch(src, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        url = URL.createObjectURL(await r.blob());
        blobs.set(src, url);
      } catch { url = src; }
      el.classList.remove('loading');
    }
    if (curSrc !== src) return false;
    audio.src = url;
    audio.playbackRate = rate;
    return true;
  }
  function pauseOthers() { document.querySelectorAll('video').forEach(v => { try { v.pause(); } catch {} }); }
  async function toggle(el) {
    if (curEl === el && curSrc === el.dataset.src && audio.src && !audio.paused) { audio.pause(); return; }
    if (!(await load(el))) return;
    pauseOthers();
    audio.play().catch(() => {});
  }
  async function seekFrom(el, clientX) {
    const wave = el.querySelector('.vp-wave');
    const r = wave.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    if (!(await load(el))) return;
    const go = () => { const d = audio.duration && isFinite(audio.duration) ? audio.duration : Number(el.dataset.dur) || 0; if (d) audio.currentTime = f * d; paint(); };
    if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
  }
  // Capture phase: a tap on the player never also opens the bubble's own
  // menus / click handlers.
  document.addEventListener('click', (e) => {
    const vp = e.target.closest('.vp');
    if (!vp) return;
    e.stopPropagation();
    if (e.target.closest('.vp-play')) toggle(vp);
    else if (e.target.closest('.vp-speed')) {
      rate = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
      document.querySelectorAll('.vp-speed').forEach(b => { b.textContent = rate + 'x'; });
      audio.playbackRate = rate;
    }
  }, true);
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const wave = e.target.closest('.vp-wave');
    if (!wave) return;
    e.preventDefault(); e.stopPropagation();
    const vp = wave.closest('.vp');
    drag = { vp, id: e.pointerId };
    try { wave.setPointerCapture(e.pointerId); } catch {}
    seekFrom(vp, e.clientX);
  }, true);
  document.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) { e.preventDefault(); seekFrom(drag.vp, e.clientX); } }, true);
  const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('.vp-wave, .vp-play, .vp-speed')) e.preventDefault(); }, true);

  window.PRAVoicePlayer = { html, hydrate, fmt };
})();
