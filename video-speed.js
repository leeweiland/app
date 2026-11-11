// Playback speed for every playable video (anything with controls): a small
// "1x" pill on the video opens .25x-8x. The last speed picked -- here or in
// the browser's own video menu -- is remembered on this device and used for
// every video after that, so a coach scanning student videos at 2x stays at 2x.
(function () {
  const RATES = [0.25, 0.5, 1, 1.5, 2, 4, 8];
  const KEY = 'pra-video-speed';
  const label = (r) => `${r}x`.replace(/^0\./, '.');
  function savedRate() {
    let r = 1;
    try { r = Number(localStorage.getItem(KEY)) || 1; } catch {}
    return RATES.includes(r) ? r : 1;
  }
  function saveRate(r) { try { localStorage.setItem(KEY, String(r)); } catch {} }

  // Set by us, so the ratechange it fires isn't mistaken for the user's choice.
  const settingRate = new WeakSet();
  function applyRate(v, r) {
    if (v.playbackRate === r) return;
    settingRate.add(v);
    try { v.playbackRate = r; v.defaultPlaybackRate = r; }
    catch { v.playbackRate = 1; } // a browser that can't play this fast
    setTimeout(() => settingRate.delete(v), 0);
  }

  const style = document.createElement('style');
  style.textContent = `
    .vs-pill { position: absolute; z-index: 4; padding: 3px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,.35); background: rgba(0,0,0,.6); color: #fff; font: 600 12px/1.2 system-ui, sans-serif; cursor: pointer; }
    .vs-pill:hover { background: #009bff; border-color: #009bff; }
    .vs-menu { position: absolute; z-index: 5; display: flex; flex-direction: column; background: rgba(10,12,16,.95); border: 1px solid rgba(255,255,255,.2); border-radius: 8px; padding: 4px; }
    .vs-menu button { background: none; border: 0; color: #fff; font: 13px/1.2 system-ui, sans-serif; padding: 6px 14px; text-align: left; border-radius: 5px; cursor: pointer; }
    .vs-menu button:hover, .vs-menu button.on { background: #009bff; }
  `;
  document.head.appendChild(style);

  const pills = new WeakMap();
  function place(v, el, dy) {
    el.style.left = (v.offsetLeft + 8) + 'px';
    el.style.top = (v.offsetTop + 8 + (dy || 0)) + 'px';
  }
  function closeMenus() { document.querySelectorAll('.vs-menu').forEach(m => m.remove()); }
  function ensurePill(v) {
    const host = v.parentElement;
    if (!host) return;
    let pill = pills.get(v);
    if (!pill || !pill.isConnected) {
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'vs-pill';
      pill.title = 'Playback speed';
      pill.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const open = host.querySelector('.vs-menu');
        closeMenus();
        if (open) return;
        const menu = document.createElement('div');
        menu.className = 'vs-menu';
        for (const r of RATES) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label(r);
          if (r === savedRate()) b.className = 'on';
          b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setEverywhere(r); closeMenus(); });
          menu.appendChild(b);
        }
        host.appendChild(menu);
        place(v, menu, pill.offsetHeight + 4);
      });
      host.appendChild(pill);
      pills.set(v, pill);
    }
    pill.textContent = label(savedRate());
    place(v, pill);
  }
  function setEverywhere(r) {
    saveRate(r);
    document.querySelectorAll('video[controls]').forEach(v => { applyRate(v, r); if (pills.has(v)) ensurePill(v); });
  }

  const isPlayable = (t) => t && t.tagName === 'VIDEO' && t.hasAttribute('controls');
  for (const ev of ['loadedmetadata', 'play']) {
    document.addEventListener(ev, (e) => {
      if (!isPlayable(e.target)) return;
      applyRate(e.target, savedRate());
      ensurePill(e.target);
    }, true);
  }
  // Picked from the browser's own video menu instead -- remember that too.
  document.addEventListener('ratechange', (e) => {
    const v = e.target;
    if (!isPlayable(v) || settingRate.has(v) || !RATES.includes(v.playbackRate)) return;
    if (v.playbackRate !== savedRate()) setEverywhere(v.playbackRate);
  }, true);
  document.addEventListener('click', (e) => { if (!e.target.closest('.vs-menu, .vs-pill')) closeMenus(); });
})();
