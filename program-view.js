// program-view.js -- renders a dripped program (e.g. the Powerbatics
// Handstand Protocol) inside training-protocol.html, plus the step types
// only programs use: "timer" (interval timer), "cta" (problem / agitate /
// solve card + button), "youtube" and "section". Data comes from
// GET /api/chat/protocol-program/:userId (chat_backend.js buildProgramView):
// students only ever receive unlocked days plus the next locked day.
(function () {
  const NEON = '#d4ff00';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');

  const CSS = `
  .pv { max-width: 1100px; margin: 18px auto 0; }
  .pv-label { font-family: var(--font-secondary); font-weight: 400; font-size: .68rem; letter-spacing: .14em; text-transform: uppercase; color: var(--pra-dim); }
  .pv-hero { text-align: center; padding: 6px 4px 18px; }
  .pv-kicker { font-family: var(--font-secondary); font-size: .7rem; letter-spacing: .3em; color: ${NEON}; text-transform: uppercase; }
  .pv-title { font-family: var(--font-primary); font-weight: 800; font-size: clamp(1.5rem, 5cqi, 2.3rem); margin: 6px 0 4px; letter-spacing: .01em; }
  .pv-goal { color: var(--pra-dim); font-size: .9rem; font-weight: 600; }
  .pv-progress { max-width: 420px; margin: 16px auto 0; }
  .pv-progress-bar { height: 6px; border-radius: 6px; background: var(--pra-border); overflow: hidden; }
  .pv-progress-bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--pra-blue), ${NEON}); border-radius: 6px; }
  .pv-progress-row { display: flex; justify-content: space-between; margin-top: 7px; }
  .pv-chat-btn { display: inline-flex; align-items: center; gap: 8px; margin-top: 16px; padding: 9px 18px; border-radius: 999px; border: 1px solid var(--pra-border); background: rgba(255,255,255,0.03); color: #fff; font: inherit; font-size: .82rem; cursor: pointer; text-decoration: none; }
  .pv-chat-btn:hover { border-color: var(--pra-blue); color: var(--pra-blue); }
  .pv-chat-btn svg { width: 16px; height: 16px; }
  .pv-app { margin-top: 16px; }
  /* Only on a computer -- on a phone they're already holding the device. */
  @media (max-width: 760px), (hover: none) { .pv-app { display: none; } }
  .pv-app-row { display: flex; justify-content: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .pv-app-btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--pra-border); background: rgba(255,255,255,0.03); color: #fff; font-size: .78rem; font-weight: 700; text-decoration: none; transition: border-color .15s, color .15s; }
  .pv-app-btn:hover { border-color: var(--pra-blue); color: var(--pra-blue); }
  .pv-app-btn svg { width: 16px; height: 16px; }
  .pv-note { max-width: 760px; margin: 0 auto 16px; padding: 10px 14px; border-radius: 10px; border: 1px dashed rgba(0,155,255,0.45); background: var(--pra-blue-dim); color: #cfe9ff; font-size: .8rem; font-weight: 600; line-height: 1.5; text-align: center; }
  .pv-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .pv-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; max-width: 680px; width: 100%; margin: 0 auto; }
  @container pra-app (min-width: 1000px) {
    .pv-layout.has-side { grid-template-columns: minmax(0, 1fr) 320px; align-items: start; }
    .pv-layout.has-side .pv-main { margin: 0; justify-self: end; }
    .pv-side { position: sticky; top: 12px; }
  }
  .pv-block { background: var(--pra-panel); border: 1px solid var(--pra-border); border-radius: 16px; overflow: hidden; }
  .pv-block > summary { list-style: none; cursor: pointer; }
  .pv-block > summary::-webkit-details-marker { display: none; }
  .pv-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
  .pv-num { flex-shrink: 0; width: 52px; height: 52px; border-radius: 12px; border: 1px solid var(--pra-border); display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(255,255,255,0.02); }
  .pv-num b { font-family: var(--font-secondary); font-weight: 400; font-size: 1.25rem; color: #fff; line-height: 1; }
  .pv-num small { font-family: var(--font-secondary); font-size: .52rem; letter-spacing: .16em; color: var(--pra-dim); margin-top: 3px; }
  .pv-head-text { flex: 1; min-width: 0; }
  .pv-head-title { font-size: 1.05rem; font-weight: 700; color: #fff; }
  .pv-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .pv-chip { font-family: var(--font-secondary); font-size: .58rem; letter-spacing: .12em; text-transform: uppercase; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--pra-border); color: var(--pra-dim); }
  .pv-chip.today { color: #000; background: ${NEON}; border-color: ${NEON}; }
  .pv-chip.on { color: var(--pra-blue); border-color: rgba(0,155,255,0.45); }
  .pv-chip.off { color: #ff9b9b; border-color: rgba(255,92,92,0.4); }
  .pv-caret { color: var(--pra-dim); transition: transform .2s; font-size: .9rem; }
  details[open] > summary .pv-caret { transform: rotate(180deg); }
  .pv-today-block { border-color: rgba(212,255,0,0.35); box-shadow: 0 0 0 1px rgba(212,255,0,0.08), 0 0 28px rgba(212,255,0,0.06); }
  .pv-today-block .pv-num { border-color: ${NEON}; }
  .pv-today-block .pv-num b { color: ${NEON}; }
  .pv-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 14px; }
  .pv-step video, .pv-step img { width: 100%; display: block; border-radius: 12px; background: #000; }
  .pv-step-label { margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .pv-ask { background: none; border: 1px solid var(--pra-border); color: var(--pra-dim); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: .7rem; cursor: pointer; white-space: nowrap; }
  .pv-ask:hover { color: var(--pra-blue); border-color: var(--pra-blue); }
  .pv-text { font-size: .93rem; font-weight: 400; line-height: 1.6; color: #e9e9ee; }
  .pv-text p { margin: 0 0 10px; }
  .pv-text p:last-child { margin-bottom: 0; }
  .pv-text .pv-label { display: block; margin: 0 0 4px; color: var(--pra-blue); }
  .pv-text ul { margin: 0; padding-left: 0; list-style: none; }
  .pv-text li { position: relative; padding-left: 18px; margin: 3px 0; }
  .pv-text li::before { content: ''; position: absolute; left: 3px; top: .62em; width: 6px; height: 6px; border-radius: 50%; background: ${NEON}; }
  /* DIAGNOSIS: faults to check, each with a glowing red X (Lee, 2026-11-17) */
  .pv-text ul.pv-x li { padding-left: 24px; }
  .pv-text ul.pv-x li::before { content: '✕'; left: 0; top: 0; width: auto; height: auto; border-radius: 0; background: none; color: #ff3b3b; font-weight: 900; font-size: 1.05em; line-height: inherit; text-shadow: 0 0 6px rgba(255,40,40,.95), 0 0 14px rgba(255,40,40,.6); }
  .pv-bump-move .pv-label { display: block; margin: 10px 0 3px; }
  .pv-bump-move ul.pv-x { margin: 0; padding-left: 0; list-style: none; }
  .pv-bump-move ul.pv-x li { position: relative; padding-left: 24px; margin: 3px 0; font-size: .84rem; color: #d6d6dc; }
  .pv-bump-move ul.pv-x li::before { content: '✕'; position: absolute; left: 0; top: 0; color: #ff3b3b; font-weight: 900; text-shadow: 0 0 6px rgba(255,40,40,.95), 0 0 14px rgba(255,40,40,.6); }
  .pv-bump-move .pv-bump-imgwrap + .pv-bump-imgwrap { margin-top: 10px; }
  .pv-text-title { font-weight: 700; font-size: 1rem; margin-bottom: 6px; color: #fff; }
  .pv-yt { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; background: #000; }
  .pv-yt iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .pv-yt-thumb { width: 100%; display: block; border-radius: 10px; }
  .pv-yt-title { font-weight: 700; font-size: 1.02rem; margin: 12px 0 4px; }
  /* Agitate + solve sit in the neon box; the button is solid neon with black text (Lee, 2026-11-17). */
  .pv-cta { border: 1.5px solid ${NEON}; border-radius: 14px; padding: 16px 16px 18px; background: linear-gradient(180deg, rgba(212,255,0,0.10), rgba(212,255,0,0.03)); box-shadow: 0 0 22px rgba(212,255,0,0.12); }
  .pv-cta p { margin: 0 0 10px; font-size: .92rem; line-height: 1.55; font-weight: 500; color: #fff; }
  .pv-cta p.pv-cta-solve { color: ${NEON}; font-weight: 700; }
  .pv-cta-btn { display: inline-flex; align-items: center; gap: 8px; margin-top: 4px; padding: 12px 18px; border-radius: 10px; border: 0; background: ${NEON}; color: #000; text-decoration: none; font-weight: 800; font-size: .88rem; letter-spacing: .02em; transition: box-shadow .15s, transform .15s; }
  .pv-cta-btn:hover { box-shadow: 0 0 20px rgba(212,255,0,0.45); transform: translateY(-1px); }
  .pv-locked { display: flex; align-items: center; gap: 14px; padding: 16px; border-radius: 16px; border: 1px dashed var(--pra-border); background: rgba(255,255,255,0.015); }
  .pv-locked .pv-num { opacity: .7; }
  .pv-lock-ico { width: 22px; height: 22px; flex-shrink: 0; color: var(--pra-dim); }
  .pv-locked-title { font-weight: 700; color: #bdbdc6; }
  .pv-countdown { font-family: var(--font-secondary); font-size: .78rem; letter-spacing: .06em; color: var(--pra-blue); margin-top: 3px; }
  .pv-side { display: flex; flex-direction: column; gap: 10px; }
  .pv-side-title { padding: 0 2px; }
  .pv-bump .pv-head { padding: 12px 14px; }
  .pv-addons { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; padding-top: 18px; border-top: 2px solid ${NEON}; }
  .pv-addons-title { font-family: var(--font-secondary); font-size: .8rem; letter-spacing: .22em; text-transform: uppercase; color: ${NEON}; text-align: center; }
  .pv-bump { border: 1px solid rgba(212,255,0,0.45); border-left: 4px solid ${NEON}; }
  .pv-addon-chip { display: inline-block; padding: 2px 8px; border-radius: 999px; background: ${NEON}; color: #000; font-family: var(--font-secondary); font-size: .58rem; letter-spacing: .14em; font-weight: 700; }
  .pv-bump-intro { font-size: .84rem; font-weight: 400; color: var(--pra-dim); line-height: 1.5; }
  .pv-bump-move { border-top: 1px solid var(--pra-border); padding-top: 12px; position: relative; }
  .pv-bump-media { position: relative; }
  .pv-bump-move p:empty, .pv-bump-intro:empty { display: none; }
  .pv-bump-move video { display: block; width: 100%; max-height: 240px; object-fit: contain; background: #000; border-radius: 10px; }
  .pv-bump-move h4 { margin: 10px 0 4px; font-size: .92rem; }
  .pv-bump-move p { margin: 0 0 4px; font-size: .84rem; font-weight: 400; line-height: 1.5; color: #d6d6dc; }
  .pv-bump-move p.why { color: var(--pra-dim); }
  .pv-bump-img { display: block; width: 100%; border-radius: 10px; margin-top: 8px; }
  .pv-empty { text-align: center; color: var(--pra-dim); padding: 40px 10px; font-size: .9rem; }
  /* Interval timer */
  .pv-timer { border: 1px solid var(--pra-border); border-radius: 16px; padding: 14px 14px 16px; background: radial-gradient(circle at 50% 40%, rgba(255,255,255,0.035), transparent 70%); text-align: center; }
  .pv-timer-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .pv-timer-spec { font-size: .74rem; color: var(--pra-dim); font-weight: 600; }
  .pv-timer-ring { position: relative; width: min(250px, 72vw); aspect-ratio: 1; margin: 12px auto 10px; }
  .pv-timer-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  .pv-timer-ring circle { fill: none; stroke-width: 7; }
  .pv-timer-ring .bg { stroke: var(--pra-border); }
  .pv-timer-ring .fg { stroke: #fff; stroke-linecap: round; transition: stroke .3s; }
  .pv-timer[data-phase="work"] .fg { stroke: ${NEON}; filter: drop-shadow(0 0 6px rgba(212,255,0,0.55)); }
  .pv-timer[data-phase="rest"] .fg { stroke: var(--pra-blue); filter: drop-shadow(0 0 6px var(--pra-blue-glow)); }
  .pv-timer-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .pv-timer-phase { font-family: var(--font-secondary); font-size: .8rem; letter-spacing: .26em; color: var(--pra-dim); }
  .pv-timer[data-phase="work"] .pv-timer-phase { color: ${NEON}; }
  .pv-timer[data-phase="rest"] .pv-timer-phase { color: var(--pra-blue); }
  .pv-timer-clock { font-family: var(--font-secondary); font-size: clamp(3rem, 15cqi, 4.2rem); line-height: 1.05; color: #fff; font-variant-numeric: tabular-nums; }
  .pv-timer-round { font-size: .76rem; color: var(--pra-dim); font-weight: 700; letter-spacing: .08em; }
  .pv-timer-controls { display: flex; justify-content: center; gap: 10px; }
  .pv-timer-controls button { min-width: 110px; }
  .pv-timer-done { font-size: .82rem; color: var(--pra-dim); margin-top: 8px; min-height: 1.2em; }
  /* Floating timer (Lee, 2026-11-17): just a 60-second circle with play, reset and sound icons. No box. Draggable. */
  .pv-ftimer { position: fixed; right: 12px; bottom: 90px; z-index: 900; width: 76px; text-align: center; touch-action: none; user-select: none; cursor: grab; filter: drop-shadow(0 2px 6px rgba(0,0,0,.75)); }
  .pv-ftimer.dragging { cursor: grabbing; }
  .pv-ft-ring { position: relative; width: 64px; height: 64px; margin: 0 auto; border-radius: 50%; background: rgba(0,0,0,.35); }
  .pv-ft-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); display: block; }
  .pv-ft-ring circle { fill: none; stroke-width: 6; }
  .pv-ft-ring .bg { stroke: rgba(255,255,255,.22); }
  .pv-ft-ring .fg { stroke: ${NEON}; stroke-linecap: round; }
  .pv-ft-clock { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--font-secondary); font-size: 1rem; color: #fff; font-variant-numeric: tabular-nums; pointer-events: none; }
  .pv-ft-icons { display: flex; justify-content: center; gap: 4px; margin-top: 4px; }
  .pv-ft-icons button { width: 22px; height: 22px; padding: 0; border: 0; background: none; color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .pv-ft-icons button svg { width: 18px; height: 18px; }
  .pv-ft-icons button[data-ft="play"] svg { width: 20px; height: 20px; color: ${NEON}; }
  .pv-ft-icons button[data-ft="sound"].off { opacity: .55; }
  /* Compact versions inside the coach Flow canvas */
  .pv-compact { font-size: .8rem; line-height: 1.45; color: #d6d6dc; }
  .pv-compact b { color: #fff; }
  .pv-compact-cta { border-left: 3px solid ${NEON}; padding-left: 8px; }
  .pv-section-badge { text-align: center; font-family: var(--font-secondary); font-size: 1.1rem; color: ${NEON}; padding: 6px 0; letter-spacing: .08em; text-transform: uppercase; }`;
  function injectCss() {
    if (document.getElementById('pv-css')) return;
    const st = document.createElement('style');
    st.id = 'pv-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // "23h 12m" style countdown.
  function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${pad2(sec)}s`;
    return `${sec}s`;
  }
  function fmtWhen(iso) {
    try { return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; }
  }
  function lockedText(template, iso, now) {
    return String(template || 'Unlocks in {time}').replace(/\{time\}/g, fmtCountdown(Date.parse(iso) - now));
  }
  function ctaHref(step, settings, dayNumber) {
    const base = (settings && settings.ctaUrl) || step.url || '';
    if (!base) return '';
    try {
      const u = new URL(base, location.href);
      u.searchParams.set('src', step.srcTag || ('program-day' + (dayNumber || '')));
      return u.toString();
    } catch { return base; }
  }

  // Plain text with light structure: a short ALL-CAPS line opens a labeled
  // paragraph, "• " / "- " lines become a bullet list.
  const link = (h) => (window.PRALinkify ? window.PRALinkify(h) : h);
  function textHtml(content, title) {
    const paras = String(content || '').replace(/\r/g, '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const out = paras.map(p => {
      const lines = p.split('\n');
      let label = '';
      if (lines.length > 1 && lines[0].length <= 40 && /^[A-Z0-9][A-Z0-9 '&+\-–—:,.()/!?]*$/.test(lines[0])) label = lines.shift();
      const bullets = lines.every(l => /^\s*[•\-]\s+/.test(l));
      const xs = lines.every(l => /^\s*✕\s*/.test(l));
      const body = xs
        ? '<ul class="pv-x">' + lines.map(l => `<li>${link(esc(l.replace(/^\s*✕\s*/, '')))}</li>`).join('') + '</ul>'
        : bullets
        ? '<ul>' + lines.map(l => `<li>${link(esc(l.replace(/^\s*[•\-]\s+/, '')))}</li>`).join('') + '</ul>'
        : `<p>${lines.map(l => link(esc(l))).join('<br>')}</p>`;
      return (label ? `<span class="pv-label">${esc(label)}</span>` : '') + body;
    }).join('');
    return `<div class="pv-text">${title ? `<div class="pv-text-title">${esc(title)}</div>` : ''}${out}</div>`;
  }

  function timerHtml(s) {
    const rounds = Math.max(1, Number(s.rounds) || 1), work = Math.max(1, Number(s.workSeconds) || 60), rest = Math.max(0, Number(s.restSeconds) || 0);
    const total = rounds * work + (rounds - 1) * rest;
    const spec = `${rounds} × ${work}s${rest ? ` · ${rest}s rest` : ''} · ~${Math.round(total / 60)} min`;
    return `<div class="pv-timer" data-pv-timer data-rounds="${rounds}" data-work="${work}" data-rest="${rest}" data-phase="ready">
      <div class="pv-timer-top"><span class="pv-label">Interval Timer</span><span class="pv-timer-spec">${esc(spec)}</span></div>
      <div class="pv-timer-ring"><svg viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="54"/><circle class="fg" cx="60" cy="60" r="54" stroke-dasharray="339.29" stroke-dashoffset="0"/></svg>
        <div class="pv-timer-center"><div class="pv-timer-phase">READY</div><div class="pv-timer-clock">${Math.floor(work / 60)}:${pad2(work % 60)}</div><div class="pv-timer-round">ROUND 1 / ${rounds}</div></div></div>
      <div class="pv-timer-controls"><button type="button" class="pra-btn" data-act="toggle">Start</button><button type="button" class="pra-btn pra-btn-ghost" data-act="reset">Reset</button></div>
      <div class="pv-timer-done"></div>
    </div>`;
  }

  // "Get the app" buttons (Programs Editor > App buttons). Web only: inside
  // the iPhone/Android app they already have it.
  function appButtonsHtml(ab) {
    if (!ab || ab.enabled === false) return '';
    try { if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return ''; } catch {}
    const ICONS = {
      ios: '<svg viewBox="0 0 24 24" fill="none"><rect x="7" y="2.5" width="10" height="19" rx="2.4" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
      android: '<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="9" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 9a3.5 3.5 0 0 1 7 0M9 5.5 7.8 4M15 5.5l1.2-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
      desktop: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4.5" width="18" height="12" rx="1.8" stroke="currentColor" stroke-width="1.6"/><path d="M9 20h6M12 16.5V20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    };
    const btns = [['ios', ab.iosLabel, ab.iosUrl], ['android', ab.androidLabel, ab.androidUrl]]
      .filter(([, , url]) => url)
      .map(([k, label, url]) => `<a class="pv-app-btn" href="${esc(url)}" target="_blank" rel="noopener">${ICONS[k]}<span>${esc(label || k)}</span></a>`).join('');
    if (!btns) return '';
    return `<div class="pv-app"><div class="pv-label" data-hero="appHeading">${esc(ab.heading || 'Get the app')}</div><div class="pv-app-row">${btns}</div></div>`;
  }
  function youtubeHtml(s, compact) {
    const id = encodeURIComponent(s.youtubeId || '');
    if (compact) return `<div class="step-type">YouTube</div><img class="pv-yt-thumb" src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt=""/><div class="pv-compact" style="margin-top:6px"><b>${esc(s.title || '')}</b></div>`;
    return `<div class="pv-yt"><iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&playsinline=1" title="${esc(s.title || 'Video')}" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>
      ${s.title ? `<div class="pv-yt-title">${esc(s.title)}</div>` : ''}${s.intro ? `<div class="pv-text"><p>${esc(s.intro)}</p></div>` : ''}`;
  }

  function ctaHtml(s, settings, dayNumber, compact) {
    const href = ctaHref(s, settings, dayNumber);
    if (compact) return `<div class="step-type">Button</div><div class="pv-compact pv-compact-cta">${esc(s.agitate || s.problem || '')}<br><b>${esc(s.buttonText || 'Book your free Fast Track Call')} →</b></div>`;
    return `<div class="pv-cta">
      ${s.agitate ? `<p>${esc(s.agitate)}</p>` : ''}${s.solve ? `<p class="pv-cta-solve">${esc(s.solve)}</p>` : ''}
      ${href ? `<a class="pv-cta-btn" href="${esc(href)}" target="_blank" rel="noopener">${esc(s.buttonText || 'Book your free Fast Track Call')} <span aria-hidden="true">→</span></a>` : ''}
    </div>`;
  }

  // Shared with training-protocol.html's renderStepContent for the step
  // types it doesn't know (compact = the coach Flow canvas card).
  function stepHtml(s, opts = {}) {
    injectCss(); // the Flow canvas uses these cards before any program view renders
    const compact = !!opts.compact;
    if (s.type === 'timer') {
      if (compact) return `<div class="step-type">Timer</div><div class="pv-compact"><b>${Number(s.rounds) || 1} rounds</b> · ${Number(s.workSeconds) || 0}s work / ${Number(s.restSeconds) || 0}s rest</div>`;
      return timerHtml(s);
    }
    if (s.type === 'cta') return ctaHtml(s, opts.settings, opts.dayNumber, compact);
    if (s.type === 'youtube') return youtubeHtml(s, compact);
    if (s.type === 'section') return `<div class="pv-section-badge">${esc(s.title || s.content || 'Section')}</div>`;
    return '';
  }

  function programStepHtml(s, ctx) {
    const askBtn = ctx.canAsk && (s.type === 'video' || s.type === 'image') ? `<button type="button" class="pv-ask" data-ask="${esc(s.id)}">Ask a question</button>` : '';
    if (s.type === 'video') {
      const label = s.moveLabel || s.name || '';
      return `<div class="pv-step" data-step-id="${esc(s.id)}">${label || askBtn ? `<div class="pv-step-label"><span class="pv-label" data-edit="moveLabel">${esc(label)}</span>${askBtn}</div>` : ''}
        ${s.sound ? `<video data-sound data-src="/api/chat/media/${encodeURIComponent(s.driveFileId)}#t=0.5" controls preload="metadata" playsinline></video>` : `<video data-src="/api/chat/media/${encodeURIComponent(s.driveFileId)}#t=0.5" controls loop autoplay muted preload="metadata" playsinline></video>`}</div>`;
    }
    if (s.type === 'image') {
      return `<div class="pv-step" data-step-id="${esc(s.id)}">${askBtn ? `<div class="pv-step-label"><span></span>${askBtn}</div>` : ''}<img loading="lazy" src="/api/chat/media/${encodeURIComponent(s.driveFileId)}" alt="${esc(s.alt || s.caption || '')}"/></div>`;
    }
    if (s.type === 'text') return `<div class="pv-step" data-step-id="${esc(s.id)}">${textHtml(s.content, s.title)}</div>`;
    if (['timer', 'cta', 'youtube'].includes(s.type)) return `<div class="pv-step" data-step-id="${esc(s.id)}">${stepHtml(s, { settings: ctx.settings, dayNumber: ctx.dayNumber })}</div>`;
    return '';
  }

  function numBox(n, label = 'DAY') { return `<div class="pv-num"><b>${pad2(n)}</b><small>${label}</small></div>`; }
  const LOCK_SVG = '<svg class="pv-lock-ico" viewBox="0 0 24 24" fill="none"><rect x="5" y="10.5" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  const CHAT_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 5.5h16v10H9l-5 4v-14Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  const every = (st) => `${st.waitAmount} ${Number(st.waitAmount) === 1 ? String(st.waitUnit).replace(/s$/, '') : st.waitUnit}`;
  function render(container, data, opts = {}) {
    injectCss();
    stopTickers(container);
    const pr = data.program;
    const staff = !!pr.staffView || !!opts.preview;
    const now = Date.now();
    const unlocked = pr.days.filter(d => d.unlocked);
    const newest = unlocked.length ? unlocked[unlocked.length - 1].dayNumber : 0;
    const ctxBase = { settings: pr.settings, canAsk: !!opts.canAsk };

    const dayBlock = (d) => {
      if (!d.unlocked && !staff) {
        return `<div class="pv-locked">${numBox(d.dayNumber)}<div class="pv-head-text"><div class="pv-locked-title">${esc(d.title || 'Day ' + d.dayNumber)}</div>
          <div class="pv-countdown" data-unlocks="${esc(d.unlocksAt)}" data-template="${esc(pr.settings.lockedText)}">${esc(lockedText(pr.settings.lockedText, d.unlocksAt, now))}</div></div>${LOCK_SVG}</div>`;
      }
      const isToday = !staff && d.dayNumber === newest;
      const chips = [d.category ? `<span class="pv-chip" data-edit="category">${esc(d.category)}</span>` : '',
        isToday ? '<span class="pv-chip today">Today</span>' : '',
        staff && !opts.preview ? (d.unlocked ? '<span class="pv-chip on">Unlocked</span>' : `<span class="pv-chip off">Opens ${esc(fmtWhen(d.unlocksAt))}</span>`) : ''].join('');
      const body = d.steps.map(s => programStepHtml(s, { ...ctxBase, dayNumber: d.dayNumber })).join('');
      return `<details class="pv-block${isToday ? ' pv-today-block' : ''}" id="pv-day-${d.dayNumber}" ${isToday ? 'open' : ''}>
        <summary class="pv-head">${numBox(d.dayNumber)}<div class="pv-head-text"><div class="pv-head-title" data-edit="title">${esc(d.title || 'Day ' + d.dayNumber)}</div><div class="pv-chips">${chips}</div></div><span class="pv-caret">▾</span></summary>
        <div class="pv-body" data-day="${esc(d.dayNumber)}">${body}</div></details>`;
    };
    const sectionBlock = (sec, i) => {
      const open = staff ? false : newest <= 1;
      const body = sec.steps.map(s => programStepHtml(s, { ...ctxBase, dayNumber: 0 })).join('');
      const secIdx = i;
      return `<details class="pv-block" ${open ? 'open' : ''}><summary class="pv-head">${numBox(i + 1, 'START')}<div class="pv-head-text"><div class="pv-head-title" data-edit="title">${esc(sec.title || 'Start here')}</div><div class="pv-chips"><span class="pv-chip" data-edit="chip">${esc(sec.chip || 'Watch before Day 1')}</span></div></div><span class="pv-caret">▾</span></summary>
        <div class="pv-body" data-section="${secIdx}">${body}</div></details>`;
    };

    // Students: newest day on top, next locked day above it. Staff: in order.
    const days = staff ? pr.days.slice() : pr.days.slice().sort((a, b) => b.dayNumber - a.dayNumber);
    const lockedFirst = staff ? [] : days.filter(d => !d.unlocked);
    const openDays = staff ? days : days.filter(d => d.unlocked);

    const pct = pr.totalDays ? Math.round((pr.unlockedCount / pr.totalDays) * 100) : 0;
    let note = '';
    if (opts.preview) {
      note = `Template preview: every day shown. Drip is <b>${pr.settings.dripEnabled ? 'on' : 'off'}</b>${pr.settings.dripEnabled ? `, a new day every ${esc(every(pr.settings))}` : ''}.`;
    } else if (pr.staffView) {
      const next = pr.days.find(d => !d.unlocked);
      note = `Coach view: you see every day. Drip is <b>${pr.settings.dripEnabled ? 'on' : 'off'}</b>${pr.settings.dripEnabled ? ` (a new day every ${esc(every(pr.settings))})` : ''}.
        Started ${pr.startedAt ? esc(fmtWhen(pr.startedAt)) : 'not yet'} · <b>Day ${pr.unlockedCount} of ${pr.totalDays}</b> unlocked for them${next ? ` · Day ${next.dayNumber} opens ${esc(fmtWhen(next.unlocksAt))}` : ''}.
        Add-ons owned: <b>${(data.ownedBumps || []).length ? esc(data.ownedBumps.join(', ')) : 'none'}</b>.`;
    }
    const bumps = pr.bumps || [];
    const side = bumps.length ? `<section class="pv-addons"><div class="pv-addons-title">${staff ? 'Add-ons' : 'Your add-ons'}</div>
      ${bumps.map(b => `<details class="pv-block pv-bump" data-bump="${esc(b.key)}"><summary class="pv-head"><div class="pv-head-text"><div class="pv-head-title" data-bump-field="title">${esc(b.title)}</div><div class="pv-chips"><span class="pv-addon-chip">ADD-ON</span></div>
        ${staff && !opts.preview ? `<div class="pv-chips"><span class="pv-chip ${b.owned ? 'on' : 'off'}">${b.owned ? 'Owned by student' : 'Not owned by student'}</span></div>` : ''}</div><span class="pv-caret">▾</span></summary>
        <div class="pv-body">${b.intro || staff ? `<div class="pv-bump-intro" data-bump-field="intro">${esc(b.intro || '')}</div>` : ''}
        ${(b.moves || []).map((m, mi) => `<div class="pv-bump-move" data-mi="${mi}">${m.clip || m.driveFileId ? `<div class="pv-bump-media"><video data-src="/api/chat/media/${encodeURIComponent(m.clip || m.driveFileId)}#t=0.5" controls loop autoplay muted preload="metadata" playsinline></video></div>` : ''}
          <h4 data-move-field="move">${esc(m.move || '')}</h4>${m.how || staff ? `<span class="pv-label">How</span><p data-move-field="how">${esc(m.how || '')}</p>` : ''}${(m.diagnosis || []).length ? `<span class="pv-label">Diagnosis</span><ul class="pv-x">${m.diagnosis.map(x => `<li>${esc(String(x).replace(/^\s*✕\s*/, ''))}</li>`).join('')}</ul>` : ''}${m.dose ? `<span class="pv-label">Dose</span><p>${esc(m.dose)}</p>` : ''}${m.why || staff ? `<span class="pv-label">How it builds your handstand</span><p class="why" data-move-field="why">${esc(m.why || '')}</p>` : ''}${m.handstandImage ? `<div class="pv-bump-media pv-bump-imgwrap" data-img-field="handstandImage"><img class="pv-bump-img" loading="lazy" src="/api/chat/media/${encodeURIComponent(m.handstandImage)}" alt="${esc(m.move || '')}: how it builds your handstand"/></div>` : ''}${m.image ? `<div class="pv-bump-media pv-bump-imgwrap" data-img-field="image"><img class="pv-bump-img" loading="lazy" src="/api/chat/media/${encodeURIComponent(m.image)}" alt="${esc(m.move || '')} anatomy"/></div>` : ''}</div>`).join('')}</div></details>`).join('')}</section>` : '';

    const keepTimer = container.querySelector('.pv-ftimer');
    if (keepTimer) keepTimer.remove();
    container.innerHTML = `<div class="pv">
      <div class="pv-hero">
        <div class="pv-kicker" data-hero="kicker">${esc((pr.settings && pr.settings.kicker) || 'Powerbatics')}</div>
        <div class="pv-title" data-hero="displayTitle">${esc((pr.settings && pr.settings.displayTitle) || String(pr.name || '').replace(/^Powerbatics\s+/i, ''))}</div>
        ${pr.goal || staff ? `<div class="pv-goal" data-hero="goal">${esc(pr.goal || '')}</div>` : ''}
        ${!opts.preview ? `<div class="pv-progress"><div class="pv-progress-bar"><span style="width:${pct}%"></span></div><div class="pv-progress-row"><span class="pv-label">Day ${pr.unlockedCount} of ${pr.totalDays}</span><span class="pv-label">${pct}%</span></div></div>` : ''}
        ${opts.onOpenChat ? `<button type="button" class="pv-chat-btn" data-open-chat>${CHAT_SVG}${esc(opts.chatLabel || 'Open your group chat')}</button>` : ''}
        ${appButtonsHtml(pr.settings && pr.settings.appButtons)}
      </div>
      ${note ? `<div class="pv-note">${note}</div>` : ''}
      <div class="pv-layout">
        <div class="pv-main">
          ${(pr.sections || []).filter(s => s.steps.length).map(sectionBlock).join('')}
          ${lockedFirst.map(dayBlock).join('')}
          ${openDays.map(dayBlock).join('')}
          ${!pr.days.length ? '<div class="pv-empty">No days yet.</div>' : ''}
          ${side}
        </div>
      </div>
    </div>`;

    // Floating 60-second timer, kept across re-renders so a running countdown survives.
    const pvRoot = container.querySelector('.pv');
    if (keepTimer) pvRoot.appendChild(keepTimer);
    else if (pr.days.length) pvRoot.appendChild(floatingTimer());
    container.querySelectorAll('video[data-src]').forEach(v => (opts.observeVideo ? opts.observeVideo(v) : (v.src = v.dataset.src)));
    container.querySelectorAll('video:not([data-sound])').forEach(v => { v.muted = true; v.addEventListener('volumechange', () => { if (!v.muted) v.muted = true; }); });
    container.querySelectorAll('[data-ask]').forEach(b => { b.onclick = () => opts.onAsk && opts.onAsk(b.dataset.ask); });
    const chatBtn = container.querySelector('[data-open-chat]');
    if (chatBtn) chatBtn.onclick = () => opts.onOpenChat();
    mountTimers(container);
    startCountdowns(container, opts.onUnlock);
  }

  // ── Locked-day countdowns ─────────────────────────────────────────────
  const tickers = new WeakMap();
  function stopTickers(container) { const t = tickers.get(container); if (t) clearInterval(t); tickers.delete(container); }
  function startCountdowns(container, onUnlock) {
    const els = [...container.querySelectorAll('[data-unlocks]')];
    if (!els.length) return;
    let fired = false;
    const tick = () => {
      const now = Date.now();
      els.forEach(el => { el.textContent = lockedText(el.dataset.template, el.dataset.unlocks, now); });
      if (!fired && els.some(el => Date.parse(el.dataset.unlocks) <= now)) {
        fired = true;
        stopTickers(container);
        if (onUnlock) setTimeout(onUnlock, 1500);
      }
    };
    tick();
    tickers.set(container, setInterval(tick, 1000));
  }

  // ── Interval timer ─────────────────────────────────────────────────────
  let audioCtx = null;
  let timerSound = false; try { timerSound = localStorage.getItem('pvTimerSound') === '1'; } catch {}
  function beep(freq, dur, when = 0, vol = 0.25) {
    if (!timerSound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime + when;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch {}
  }
  const allTimers = new Set();
  function mountTimers(root) {
    root.querySelectorAll('[data-pv-timer]').forEach(el => { if (!el._pvTimer) el._pvTimer = createTimer(el); });
  }
  function createTimer(el) {
    const rounds = Number(el.dataset.rounds), work = Number(el.dataset.work), rest = Number(el.dataset.rest);
    const phases = [{ kind: 'prep', secs: 5, round: 1 }];
    for (let r = 1; r <= rounds; r++) {
      phases.push({ kind: 'work', secs: work, round: r });
      if (rest && r < rounds) phases.push({ kind: 'rest', secs: rest, round: r + 1 });
    }
    const $ = (sel) => el.querySelector(sel);
    const fg = $('.fg'), CIRC = 339.29;
    let idx = 0, running = false, endsAt = 0, leftMs = phases[0].secs * 1000, lastWhole = null, raf = null, iv = null, wakeLock = null, done = false;
    const api = { pause, isRunning: () => running };
    allTimers.add(api);

    function paint(ms) {
      const ph = phases[idx];
      const secsLeft = Math.ceil(ms / 1000);
      el.dataset.phase = done ? 'done' : (running || idx > 0 || ms < ph.secs * 1000) ? ph.kind : 'ready';
      $('.pv-timer-phase').textContent = done ? 'DONE' : el.dataset.phase === 'ready' ? 'READY' : ph.kind === 'prep' ? 'GET READY' : ph.kind === 'work' ? 'WORK' : 'REST';
      const shown = done ? 0 : el.dataset.phase === 'ready' ? work : secsLeft;
      $('.pv-timer-clock').textContent = `${Math.floor(shown / 60)}:${pad2(shown % 60)}`;
      $('.pv-timer-round').textContent = `ROUND ${done ? rounds : ph.round} / ${rounds}`;
      const frac = done ? 1 : el.dataset.phase === 'ready' ? 0 : 1 - ms / (ph.secs * 1000);
      fg.setAttribute('stroke-dashoffset', String(CIRC * frac));
    }
    function loop() {
      if (!running) return;
      if (!el.isConnected) { running = false; cancelAnimationFrame(raf); clearInterval(iv); unlockScreen(); allTimers.delete(api); return; }
      let ms = endsAt - Date.now();
      while (ms <= 0 && running) {
        idx++;
        if (idx >= phases.length) { finish(); return; }
        endsAt += phases[idx].secs * 1000;
        ms = endsAt - Date.now();
        const k = phases[idx].kind;
        if (k === 'work') { beep(1320, 0.4); } else { beep(660, 0.45); }
        lastWhole = null;
      }
      const whole = Math.ceil(ms / 1000);
      if (whole !== lastWhole) {
        if (whole <= 3 && whole >= 1 && lastWhole !== null) beep(880, 0.09);
        lastWhole = whole;
      }
      paint(ms);
      raf = requestAnimationFrame(loop);
    }
    async function lockScreen() {
      try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
    }
    function unlockScreen() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
    function start() {
      allTimers.forEach(t => { if (t !== api) t.pause(); });
      if (done) reset();
      running = true;
      endsAt = Date.now() + leftMs;
      $('[data-act="toggle"]').textContent = 'Pause';
      $('.pv-timer-done').textContent = '';
      beep(880, 0.06, 0, 0.12); // also unlocks audio on iOS (user gesture)
      lockScreen();
      cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
      clearInterval(iv); iv = setInterval(loop, 250); // keeps going when rAF is throttled
    }
    function pause() {
      if (!running) return;
      running = false;
      leftMs = Math.max(0, endsAt - Date.now());
      cancelAnimationFrame(raf); clearInterval(iv);
      $('[data-act="toggle"]').textContent = 'Resume';
      unlockScreen();
      paint(leftMs);
    }
    function reset() {
      running = false; done = false; idx = 0; leftMs = phases[0].secs * 1000; lastWhole = null;
      cancelAnimationFrame(raf); clearInterval(iv); unlockScreen();
      $('[data-act="toggle"]').textContent = 'Start';
      $('.pv-timer-done').textContent = '';
      paint(leftMs);
    }
    function finish() {
      running = false; done = true;
      cancelAnimationFrame(raf); clearInterval(iv); unlockScreen();
      beep(1320, 0.18); beep(1320, 0.18, 0.25); beep(1760, 0.5, 0.5);
      $('[data-act="toggle"]').textContent = 'Again';
      $('.pv-timer-done').textContent = `${rounds} rounds done. Nice work.`;
      paint(0);
    }
    $('[data-act="toggle"]').onclick = () => (running ? pause() : start());
    $('[data-act="reset"]').onclick = reset;
    const sb = document.createElement('button'); sb.type = 'button'; sb.className = $('[data-act="reset"]').className; sb.dataset.act = 'sound';
    const paintSound = () => { sb.textContent = timerSound ? 'Sound on' : 'Sound off'; };
    sb.onclick = () => { timerSound = !timerSound; try { localStorage.setItem('pvTimerSound', timerSound ? '1' : '0'); } catch {} document.querySelectorAll('[data-act="sound"]').forEach(b => { b.textContent = timerSound ? 'Sound on' : 'Sound off'; }); };
    paintSound(); $('[data-act="reset"]').after(sb);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running) { lockScreen(); loop(); } });
    paint(leftMs);
    return api;
  }

  // The floating timer: one 60-second countdown. Play/pause, reset, sound. Drag it
  // anywhere; its spot is remembered.
  const FT_ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5.5" width="4" height="13" rx="1"/><rect x="13.5" y="5.5" width="4" height="13" rx="1"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  };
  function floatingTimer() {
    const SECS = 60, CIRC = 2 * Math.PI * 28;
    const el = document.createElement('div');
    el.className = 'pv-ftimer';
    el.innerHTML = `<div class="pv-ft-ring"><svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="28"/><circle class="fg" cx="32" cy="32" r="28" stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="0"/></svg><div class="pv-ft-clock">1:00</div></div>
      <div class="pv-ft-icons"><button type="button" data-ft="reset" aria-label="Reset">${FT_ICON.reset}</button><button type="button" data-ft="play" aria-label="Start">${FT_ICON.play}</button><button type="button" data-ft="sound" aria-label="Sound">${FT_ICON.sound}</button></div>`;
    const fg = el.querySelector('.fg'), clock = el.querySelector('.pv-ft-clock'), playBtn = el.querySelector('[data-ft="play"]'), soundBtn = el.querySelector('[data-ft="sound"]');
    let left = SECS * 1000, endsAt = 0, running = false, iv = null, lastWhole = null, wake = null;
    const paint = () => {
      const secs = Math.ceil(left / 1000);
      clock.textContent = `${Math.floor(secs / 60)}:${pad2(secs % 60)}`;
      fg.setAttribute('stroke-dashoffset', String(CIRC * (1 - left / (SECS * 1000))));
      playBtn.innerHTML = running ? FT_ICON.pause : FT_ICON.play;
    };
    const paintSound = () => { soundBtn.innerHTML = timerSound ? FT_ICON.sound : FT_ICON.mute; soundBtn.classList.toggle('off', !timerSound); };
    const tick = () => {
      left = Math.max(0, endsAt - Date.now());
      const whole = Math.ceil(left / 1000);
      if (whole !== lastWhole) { if (whole <= 3 && whole >= 1) beep(880, 0.09); lastWhole = whole; }
      if (left <= 0) { stop(); beep(1320, 0.18); beep(1320, 0.18, 0.25); beep(1760, 0.5, 0.5); left = 0; }
      paint();
    };
    const lock = async () => { try { if ('wakeLock' in navigator && !wake) wake = await navigator.wakeLock.request('screen'); } catch {} };
    const unlock = () => { try { wake && wake.release(); } catch {} wake = null; };
    function start() { if (left <= 0) left = SECS * 1000; running = true; endsAt = Date.now() + left; lastWhole = null; beep(880, 0.06, 0, 0.12); lock(); clearInterval(iv); iv = setInterval(tick, 200); paint(); }
    function stop() { running = false; clearInterval(iv); unlock(); paint(); }
    playBtn.onclick = () => { if (running) { left = Math.max(0, endsAt - Date.now()); stop(); } else start(); };
    el.querySelector('[data-ft="reset"]').onclick = () => { stop(); left = SECS * 1000; paint(); };
    soundBtn.onclick = () => { timerSound = !timerSound; try { localStorage.setItem('pvTimerSound', timerSound ? '1' : '0'); } catch {} paintSound(); };
    try { const p = JSON.parse(localStorage.getItem('pvFloatTimerPos') || 'null'); if (p && p.x >= 0 && p.y >= 0 && p.x < window.innerWidth - 40 && p.y < window.innerHeight - 40) Object.assign(el.style, { left: p.x + 'px', top: p.y + 'px', right: 'auto', bottom: 'auto' }); } catch {}
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      el.classList.add('dragging'); el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = Math.min(window.innerWidth - el.offsetWidth - 4, Math.max(4, e.clientX - drag.dx));
      const y = Math.min(window.innerHeight - el.offsetHeight - 4, Math.max(4, e.clientY - drag.dy));
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    });
    const end = () => {
      if (!drag) return; drag = null; el.classList.remove('dragging');
      try { localStorage.setItem('pvFloatTimerPos', JSON.stringify({ x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) })); } catch {}
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running) { lock(); tick(); } });
    paint(); paintSound();
    return el;
  }

  window.PRAProgram = { render, stepHtml, mountTimers, textHtml, fmtCountdown };
})();
