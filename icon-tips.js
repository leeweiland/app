// Icon labels on phones (Lee, 2026-11-23): long-press any icon to see what it
// is, the same text a computer shows on hover (its title / aria-label /
// data-tip). The label is always kept fully on screen. Loaded on every app
// page by chat-header.js. Quick Start uses PRAIconTip.show() to demo it.
(function () {
  if (window.PRAIconTip) return;
  const st = document.createElement('style');
  st.textContent = `
  .pra-icon-tip { position: fixed; z-index: 9650; pointer-events: none; max-width: calc(100vw - 16px); box-sizing: border-box;
    padding: 7px 11px; border-radius: 9px; background: #15171c; color: #fff; border: 1px solid rgba(255,255,255,.18);
    box-shadow: 0 6px 22px rgba(0,0,0,.55); font: 700 .8rem/1.3 var(--font-primary, sans-serif); letter-spacing: .01em;
    white-space: normal; overflow-wrap: anywhere; text-align: center; opacity: 0; transform: scale(.92); transition: opacity .12s, transform .12s; }
  .pra-icon-tip.on { opacity: 1; transform: scale(1); }
  @media (hover: none) { a[title], button[title], [role="button"][title], [data-tip] { -webkit-touch-callout: none; } }`;
  document.head.appendChild(st);

  let tip = null, hideTimer = null, shownFor = null, shownAt = 0;
  const labelOf = (el) => (el.dataset.tip || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
  // An "icon": a titled link/button whose own visible text is empty or tiny
  // (a glyph, a count, a key hint) -- text buttons already say what they do.
  function iconFrom(target) {
    const el = target && target.closest && target.closest('a[title], button[title], [role="button"][title], [data-tip], a[aria-label], button[aria-label]');
    if (!el || !labelOf(el)) return null;
    if (el.closest('.bubble-row')) return null; // message bubbles keep their own long-press menu
    const text = (el.innerText || '').trim();
    if (text.length > 4 && !el.hasAttribute('data-tip')) return null;
    return el;
  }
  function hide() {
    clearTimeout(hideTimer); hideTimer = null;
    if (tip) { const t = tip; t.classList.remove('on'); setTimeout(() => t.remove(), 140); tip = null; }
  }
  // Above the icon (below it when there's no room), centered on it, clamped
  // to the screen edges.
  function show(el, opts = {}) {
    const text = opts.text || labelOf(el);
    if (!el || !text) return;
    hide();
    tip = document.createElement('div'); tip.className = 'pra-icon-tip'; tip.textContent = text;
    document.body.appendChild(tip);
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth, vh = vv ? vv.height : window.innerHeight;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, m = 8, gap = 8;
    let top = opts.below ? r.bottom + gap : r.top - gap - h;
    if (top < m && !opts.above) top = r.bottom + gap;
    if (top + h > vh - m && !opts.below) top = Math.max(m, r.top - gap - h);
    top = Math.max(m, Math.min(vh - h - m, top));
    const left = Math.max(m, Math.min(vw - w - m, r.left + r.width / 2 - w / 2));
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    requestAnimationFrame(() => tip && tip.classList.add('on'));
    shownFor = el; shownAt = Date.now();
    hideTimer = setTimeout(hide, opts.ms || 2200);
  }

  // Long-press (touch only -- a mouse already gets the hover title).
  let pressTimer = null, pressEl = null, sx = 0, sy = 0;
  document.addEventListener('touchstart', (e) => {
    hide();
    clearTimeout(pressTimer); pressTimer = null;
    const el = iconFrom(e.target);
    if (!el) return;
    // Icons inside a chat row: the row's own long-press (chat menu) stays out of it.
    if (el.closest('.convo-item')) e.stopPropagation();
    pressEl = el; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    pressTimer = setTimeout(() => { pressTimer = null; show(pressEl); if (navigator.vibrate) try { navigator.vibrate(8); } catch {} }, 450);
  }, { capture: true, passive: true });
  const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
  document.addEventListener('touchmove', (e) => {
    if (!pressTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
  }, { capture: true, passive: true });
  document.addEventListener('touchend', cancel, { capture: true, passive: true });
  document.addEventListener('touchcancel', cancel, { capture: true, passive: true });
  // The tap that ends a long-press only reveals the label -- it doesn't also
  // press the icon. Android's long-press context menu is swallowed too.
  const justShown = (target) => shownFor && Date.now() - shownAt < 900 && shownFor.contains(target);
  document.addEventListener('click', (e) => { if (justShown(e.target)) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', (e) => {
    if (justShown(e.target) || (pressEl && pressEl.contains(e.target) && pressTimer)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('scroll', hide, { capture: true, passive: true });

  window.PRAIconTip = { show, hide };
})();
