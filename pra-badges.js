// Shared profile badges + moves history, used by chat.html (profile popup),
// levels.html, users-map.html, body-scan.html, profile.html and
// training-protocol.html.
//
//   PRABadges.mount(el, userId)       -> fills el with the 4 ranked badges
//   PRABadges.mountMoves(el, userId)  -> fills el with the person's uploaded
//                                        videos (newest first) + their own
//                                        show/keep-private toggle
//
// Badges: Fuel days tracked, physique photos, moves (videos uploaded), steps
// logged. #1 in a category is gold, #2 silver, #3 bronze, everyone else blue.
(function () {
  const COLORS = { 1: ['#d4af37', '#1a1405'], 2: ['#c0c0c8', '#15151a'], 3: ['#cd7f32', '#1a0f05'] };
  const CATS = [
    ['fuel', 'Fuel days'],
    ['photos', 'Photos'],
    ['moves', 'Moves'],
    ['steps', 'Steps'],
  ];

  const css = `
  .prab-row { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; margin: 10px 0 4px; }
  .prab { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 52px; }
  .prab-num { min-width: 38px; height: 38px; padding: 0 6px; border-radius: 19px; display: flex; align-items: center; justify-content: center; font-family: var(--font-secondary, inherit); font-weight: 700; font-size: .78rem; box-shadow: 0 0 10px rgba(0,155,255,0.25); box-sizing: border-box; }
  .prab-label { font-family: var(--font-secondary, inherit); font-size: .58rem; letter-spacing: .05em; text-transform: uppercase; color: var(--pra-dim, #8a8a96); white-space: nowrap; }
  .pra-moves { margin-top: 12px; text-align: left; }
  .pra-moves-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  .pra-moves-title { font-family: var(--font-secondary, inherit); font-size: .68rem; letter-spacing: .05em; text-transform: uppercase; color: var(--pra-dim, #8a8a96); }
  .pra-moves-toggle { display: flex; align-items: center; gap: 8px; font-size: .74rem; color: var(--pra-dim, #8a8a96); cursor: pointer; }
  .pra-moves-toggle input { appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; flex-shrink: 0; background: var(--pra-border, #2a2a33); border-radius: 10px; cursor: pointer; transition: background .15s; margin: 0; }
  .pra-moves-toggle input::before { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .pra-moves-toggle input:checked { background: var(--pra-blue, #009bff); }
  .pra-moves-toggle input:checked::before { transform: translateX(14px); }
  .pra-moves-list { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 4px; scrollbar-color: var(--pra-blue-dim, #1f3b55) transparent; scrollbar-width: thin; }
  .pra-moves-list::-webkit-scrollbar { width: 8px; }
  .pra-moves-list::-webkit-scrollbar-track { background: transparent; }
  .pra-moves-list::-webkit-scrollbar-thumb { background: #2a2a33; border-radius: 8px; }
  .pra-moves-list::-webkit-scrollbar-thumb:hover { background: #3a3a45; }
  .pra-move { background: rgba(255,255,255,0.03); border: 1px solid var(--pra-border, #2a2a33); border-radius: 8px; padding: 7px 10px; cursor: pointer; }
  .pra-move:hover { border-color: var(--pra-blue, #009bff); }
  .pra-move-row { display: flex; align-items: center; gap: 10px; font-size: .78rem; }
  .pra-move-date { color: var(--pra-blue, #009bff); font-family: var(--font-secondary, inherit); font-size: .68rem; white-space: nowrap; }
  .pra-move-name { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .pra-move video { width: 100%; max-height: 360px; margin-top: 8px; border-radius: 6px; background: #000; display: block; }
  .pra-moves-empty { font-size: .78rem; color: var(--pra-dim, #8a8a96); padding: 6px 0; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let badgesPromise = null;
  function loadBadges() {
    if (!badgesPromise) {
      badgesPromise = fetch('/api/chat/badges').then(r => r.ok ? r.json() : { users: {} }).catch(() => ({ users: {} }));
    }
    return badgesPromise;
  }

  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function mount(el, userId) {
    if (!el || !userId) return;
    el.classList.add('prab-row');
    const data = await loadBadges();
    const b = (data.users || {})[userId];
    if (!b) { el.innerHTML = ''; return; }
    el.innerHTML = CATS.map(([cat, label]) => {
      const c = b[cat] || { n: 0, rank: null };
      const [bg, fg] = COLORS[c.rank] || ['#009bff', '#fff'];
      const title = c.rank ? `#${c.rank} in ${label}` : label;
      return `<div class="prab" title="${esc(title)}"><div class="prab-num" style="background:${bg};color:${fg}">${fmt(c.n)}</div><div class="prab-label">${label}</div></div>`;
    }).join('');
  }

  async function mountMoves(el, userId) {
    if (!el || !userId) return;
    el.classList.add('pra-moves');
    el.innerHTML = '<div class="pra-moves-empty">Loading moves…</div>';
    let d;
    try {
      const r = await fetch('/api/chat/user-moves/' + encodeURIComponent(userId));
      d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
    } catch { el.innerHTML = ''; return; }
    const toggle = d.isSelf
      ? `<label class="pra-moves-toggle"><span>${d.showMoves ? 'Show all your moves' : 'Keep my moves private'}</span><input type="checkbox" ${d.showMoves ? 'checked' : ''}/></label>`
      : '';
    let body;
    if (d.hidden) body = '<div class="pra-moves-empty">Moves are private.</div>';
    else if (!d.videos.length) body = '<div class="pra-moves-empty">No moves uploaded yet.</div>';
    else body = `<div class="pra-moves-list">${d.videos.map(v => {
      const date = new Date(v.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `<div class="pra-move" data-file="${esc(v.driveFileId)}"><div class="pra-move-row"><span class="pra-move-date">${date}</span><span class="pra-move-name">${esc(v.name || 'Move')}</span></div></div>`;
    }).join('')}</div>`;
    el.innerHTML = `<div class="pra-moves-head"><span class="pra-moves-title">Moves (${d.hidden ? 0 : d.videos.length})</span>${toggle}</div>${body}`;

    el.querySelectorAll('.pra-move').forEach(row => {
      row.onclick = (e) => {
        if (e.target.tagName === 'VIDEO') return;
        const existing = row.querySelector('video');
        if (existing) { existing.remove(); return; }
        const v = document.createElement('video');
        v.controls = true; v.playsInline = true; v.preload = 'metadata';
        v.src = '/api/chat/media/' + encodeURIComponent(row.dataset.file);
        row.appendChild(v);
        v.play().catch(() => {});
      };
    });
    const cb = el.querySelector('.pra-moves-toggle input');
    if (cb) cb.onchange = async () => {
      const r = await fetch('/api/chat/me/show-moves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ show: cb.checked }) });
      if (r.ok) cb.previousElementSibling.textContent = cb.checked ? 'Show all your moves' : 'Keep my moves private';
      else cb.checked = !cb.checked;
    };
  }

  window.PRABadges = { mount, mountMoves };
})();
