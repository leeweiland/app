// katas.js -- a student's katas (one video per level they're at), shared by
// the training protocol's Katas tab and the kata icon under a student's own
// levels in the profile panel (profile-panel.js) everywhere it appears.
//   PRAKatas.get(userId)            -> { user, katas:[{cat, level, label, video}] }
//   PRAKatas.renderList(el, data)   -> column of labeled videos (Page-view player)
//   PRAKatas.openLightbox(kata)     -> same player, in a lightbox
(function () {
  if (window.PRAKatas) return;
  // Speed pill (.25x-8x) on every kata video, same as Page/Flow.
  if (!document.querySelector('script[src*="video-speed.js"]')) {
    const s = document.createElement('script'); s.src = '/chat-app/video-speed.js'; document.head.appendChild(s);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const style = document.createElement('style');
  style.textContent = `
    .kata-list { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 640px; margin: 0 auto; }
    .kata-card { padding: 12px; }
    .kata-card .kata-label { font-family: var(--font-secondary, sans-serif); font-size: .8rem; letter-spacing: .05em; text-transform: uppercase; color: #fff; margin-bottom: 8px; }
    .kata-card video { width: 100%; max-height: 70vh; border-radius: 8px; background: #000; display: block; }
    .kata-card .kata-missing { color: var(--pra-dim, #8a8a96); font-size: .82rem; padding: 18px 0; text-align: center; border: 1px dashed var(--pra-border, #26262e); border-radius: 8px; }
    .kata-empty { color: var(--pra-dim, #8a8a96); text-align: center; padding: 30px 10px; font-size: .9rem; }
    .kata-lb { position: fixed; inset: 0; z-index: 3000; background: rgba(0,0,0,.88); display: flex; align-items: center; justify-content: center; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom)); }
    .kata-lb-inner { position: relative; width: 100%; max-width: 760px; }
    .kata-lb-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; color: #fff; font-family: var(--font-secondary, sans-serif); font-size: .85rem; letter-spacing: .05em; text-transform: uppercase; }
    .kata-lb-close { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.25); color: #fff; width: 34px; height: 34px; border-radius: 50%; font-size: 18px; line-height: 1; cursor: pointer; flex-shrink: 0; }
    .kata-lb video { width: 100%; max-height: calc(100vh - 120px); border-radius: 10px; background: #000; display: block; }
  `;
  document.head.appendChild(style);

  const cache = {};
  function get(userId, force) {
    const key = userId || 'me';
    if (!cache[key] || force) {
      cache[key] = fetch('/api/chat/katas' + (userId ? '?userId=' + encodeURIComponent(userId) : ''))
        .then(r => r.ok ? r.json() : r.json().then(d => Promise.reject(new Error(d.error || 'Could not load katas'))));
      cache[key].catch(() => { delete cache[key]; });
    }
    return cache[key];
  }

  // Videos load + play only while on screen (same as Page view), muted and
  // looping until someone unmutes / scrubs with the controls.
  const lazy = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    entries.forEach(({ target: v, isIntersecting }) => {
      if (isIntersecting) {
        if (!v.src && v.dataset.src) v.src = v.dataset.src;
        v.play().catch(() => {});
      } else if (!v.paused) v.pause();
    });
  }, { rootMargin: '200px 0px' }) : null;

  const videoUrl = (id) => `/api/chat/media/${encodeURIComponent(id)}`;

  function renderList(el, data) {
    const katas = data?.katas || [];
    if (!katas.length) { el.innerHTML = '<div class="kata-empty">No katas yet.</div>'; return; }
    el.innerHTML = `<div class="kata-list">${katas.map(k => `
      <div class="pra-panel kata-card">
        <div class="kata-label">${esc(k.label)}</div>
        ${k.video
          ? `<video data-src="${videoUrl(k.video.driveFileId)}#t=0.5" controls loop muted autoplay preload="metadata" playsinline></video>`
          : `<div class="kata-missing">Kata video coming soon</div>`}
      </div>`).join('')}</div>`;
    el.querySelectorAll('video[data-src]').forEach(v => { if (lazy) lazy.observe(v); else v.src = v.dataset.src; });
  }

  let lb = null;
  function closeLightbox(fromBack) {
    if (!lb) return;
    const v = lb.querySelector('video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    lb.remove(); lb = null;
    if (!fromBack && window.PRABack) PRABack.closed('kata');
  }
  function openLightbox(kata) {
    if (!kata?.video) return;
    closeLightbox(true);
    lb = document.createElement('div');
    lb.className = 'kata-lb';
    lb.innerHTML = `<div class="kata-lb-inner">
      <div class="kata-lb-head"><span>${esc(kata.label)}</span><button class="kata-lb-close" type="button" aria-label="Close">&times;</button></div>
      <video src="${videoUrl(kata.video.driveFileId)}" controls autoplay playsinline preload="metadata"></video>
    </div>`;
    lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
    lb.querySelector('.kata-lb-close').onclick = () => closeLightbox();
    document.body.appendChild(lb);
    if (window.PRABack) PRABack.push('kata', () => closeLightbox(true));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lb) closeLightbox(); });

  window.PRAKatas = { get, renderList, openLightbox };
})();
