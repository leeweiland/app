// Shared profile badges + moves feed, used by chat.html (profile popup),
// levels.html, users-map.html, body-scan.html, profile.html and
// training-protocol.html.
//
//   PRABadges.mount(el, userId)       -> icon badges with counts
//   PRABadges.mountMoves(el, userId)  -> the person's moves as a feed (newest
//                                        first, loads more on scroll), tap to
//                                        play/pause, double-tap to heart, plus
//                                        their own show/keep-private toggle
//
// Badges (icon + number, no text labels): Fuel days, physique photos, moves,
// steps, hearts received. #1 gold, #2 silver, #3 bronze, everyone else
// #009bff. Hearts are always #009bff.
(function () {
  const RANK_COLORS = { 1: '#d4af37', 2: '#c0c0c8', 3: '#cd7f32' };
  const BLUE = '#009bff';

  // Simple silhouettes, all drawn with `currentColor`.
  const ICONS = {
    // apple (fuel / nutrition)
    fuel: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.6 2.4c.2 1.4-.4 2.8-1.3 3.7-.9.9-2.2 1.5-3.4 1.4-.2-1.3.5-2.7 1.3-3.6.9-.9 2.3-1.5 3.4-1.5ZM12 8.6c1.1 0 2.4-.9 3.9-.9 1.1 0 3 .4 4.1 2.3-3.4 2-2.9 6.9.6 8.2-.7 1.8-2.4 4.6-4.3 4.6-1.5 0-2-.9-3.9-.9-2 0-2.6.9-4 .9C6.3 22.8 3 18.4 3 14.1c0-3.6 2.4-6.2 5.1-6.2 1.6 0 2.9.7 3.9.7Z"/></svg>',
    // push-up silhouette (physique photos)
    photos: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="19.4" cy="7.2" r="2" fill="currentColor"/><path d="M17.2 9.4 3.4 15.6" stroke="currentColor" stroke-width="2.2"/><path d="M16.2 9.9 16.5 13.4M16.5 13.4 16.9 16.8" stroke="currentColor" stroke-width="1.7"/><path d="M3.4 15.6 2.6 16.9" stroke="currentColor" stroke-width="1.7"/><path d="M1.6 17.6h20.8" stroke="currentColor" stroke-width="1.2" opacity=".5"/></svg>',
    // horse stance, front view (katas)
    katas: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="3.9" r="2" fill="currentColor"/><path d="M12 6.3v6" stroke="currentColor" stroke-width="2.2"/><path d="M5.4 8.6h13.2" stroke="currentColor" stroke-width="1.7"/><path d="M12 12.3 6.6 13.6 5.9 19.3M12 12.3l5.4 1.3.7 5.7" stroke="currentColor" stroke-width="1.9"/><path d="M4.3 19.6h3.2M16.5 19.6h3.2" stroke="currentColor" stroke-width="1.7"/><path d="M2.5 21.4h19" stroke="currentColor" stroke-width="1.2" opacity=".5"/></svg>',
    // video camera (moves)
    moves: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="13.5" height="12" rx="2.6" fill="currentColor"/><path fill="currentColor" d="M16.8 10.4 22 7.3v9.4l-5.2-3.1Z"/></svg>',
    // footprints (steps)
    steps: '<svg viewBox="0 0 24 24"><ellipse cx="8" cy="8.2" rx="3" ry="4.6" fill="currentColor"/><ellipse cx="8.2" cy="15.6" rx="2.1" ry="1.6" fill="currentColor"/><ellipse cx="16" cy="11.2" rx="3" ry="4.6" fill="currentColor"/><ellipse cx="16.2" cy="18.6" rx="2.1" ry="1.6" fill="currentColor"/></svg>',
    hearts: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.8 8.3 3 4.5 6.7 4.5c2.2 0 3.7 1.3 4.6 2.6.9-1.3 2.4-2.6 4.6-2.6 3.7 0 5.9 3.8 4.3 7.3C19.5 16.4 12 21 12 21Z"/></svg>',
  };
  const CATS = ['fuel', 'photos', 'moves', 'katas', 'steps', 'hearts'];
  const ARIA = { fuel: 'Fuel days', photos: 'Physique photos', moves: 'Moves', katas: 'Katas', steps: 'Steps', hearts: 'Hearts' };

  const css = `
  .prab-row { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; margin: 10px 0 4px; }
  .prab { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 34px; }
  .prab-icon { width: 30px; height: 30px; filter: drop-shadow(0 0 6px rgba(0,155,255,0.35)); }
  .prab-icon svg { width: 100%; height: 100%; display: block; }
  .prab-num { font-family: var(--font-secondary, inherit); font-weight: 700; font-size: .78rem; line-height: 1; }
  .pra-moves { margin-top: 14px; text-align: left; }
  .pra-moves-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .pra-moves-title { font-family: var(--font-secondary, inherit); font-size: .68rem; letter-spacing: .05em; text-transform: uppercase; color: var(--pra-dim, #8a8a96); }
  .pra-moves-toggle { display: flex; align-items: center; gap: 8px; font-size: .74rem; color: var(--pra-dim, #8a8a96); cursor: pointer; }
  .pra-moves-toggle input { appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; flex-shrink: 0; background: var(--pra-border, #2a2a33); border-radius: 10px; cursor: pointer; transition: background .15s; margin: 0; }
  .pra-moves-toggle input::before { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .pra-moves-toggle input:checked { background: var(--pra-blue, #009bff); }
  .pra-moves-toggle input:checked::before { transform: translateX(14px); }
  .pra-feed { display: flex; flex-direction: column; gap: 16px; }
  .pra-feed-item { background: rgba(255,255,255,0.03); border: 1px solid var(--pra-border, #2a2a33); border-radius: 12px; overflow: hidden; }
  .pra-feed-media { position: relative; background: #000; aspect-ratio: 4 / 5; cursor: pointer; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
  .pra-feed-media video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
  .pra-feed-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; transition: opacity .15s; }
  .pra-feed-play svg { width: 54px; height: 54px; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.6)); }
  .pra-feed-media.playing .pra-feed-play { opacity: 0; }
  .pra-feed-burst { position: absolute; left: 50%; top: 50%; width: 90px; height: 90px; margin: -45px 0 0 -45px; color: #ff3b47; pointer-events: none; opacity: 0; transform: scale(.4); }
  .pra-feed-burst svg { width: 100%; height: 100%; filter: drop-shadow(0 0 12px rgba(255,59,71,0.7)); }
  .pra-feed-burst.show { animation: praBurst .7s ease-out; }
  @keyframes praBurst { 0% { opacity: 0; transform: scale(.4); } 25% { opacity: 1; transform: scale(1.1); } 60% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1.15); } }
  .pra-feed-meta { display: flex; align-items: center; gap: 10px; padding: 8px 12px; font-size: .78rem; }
  .pra-feed-heart { display: flex; align-items: center; gap: 5px; background: none; border: none; padding: 0; cursor: pointer; color: #ff3b47; font-weight: 700; font-size: .85rem; }
  .pra-feed-heart span { color: #fff; }
  .pra-feed-heart svg { width: 20px; height: 20px; }
  .pra-feed-heart.liked { color: #ff3b47; }
  .pra-feed-name { color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .pra-feed-date { margin-left: auto; color: var(--pra-blue, #009bff); font-family: var(--font-secondary, inherit); font-size: .66rem; white-space: nowrap; }
  .pra-moves-empty { font-size: .78rem; color: var(--pra-dim, #8a8a96); padding: 6px 0; }
  .pra-feed-sentinel { height: 1px; }
  .prab-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .prab-row.prab-inline { margin: 0; gap: 10px; justify-content: flex-start; flex-wrap: nowrap; }
  .prab-row.prab-inline .prab { flex-direction: row; gap: 3px; min-width: 0; }
  .prab-row.prab-inline .prab-icon { width: 16px; height: 16px; }
  .prab-row.prab-inline .prab-num { font-size: .7rem; }
  .prab-profile-link { cursor: pointer; }
  .prab-profile-link:hover { color: var(--pra-blue, #009bff); }
  .prab-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 700; padding: 16px; box-sizing: border-box; }
  .prab-modal.show { display: flex; }
  .prab-modal-box { width: 100%; max-width: 560px; max-height: 88vh; max-height: 88dvh; overflow-y: auto; padding: 22px; box-sizing: border-box; text-align: center; }
  .prab-modal-avatar { width: 80px; height: 80px; margin: 0 auto 12px; font-size: 1.7rem; }
  .prab-modal-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let badgesPromise = null;
  function loadBadges(force) {
    if (!badgesPromise || force) {
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
    if (!el) return;
    el.classList.add('prab-row');
    el.dataset.badgesFor = userId || '';
    // No app account (e.g. a Levels-sheet-only gym kid) -> all zeros.
    const data = userId ? await loadBadges() : { users: {} };
    const b = (data.users || {})[userId] || {};
    el.innerHTML = CATS.map(cat => {
      const c = b[cat] || { n: 0, rank: null };
      const color = cat === 'hearts' ? BLUE : (RANK_COLORS[c.rank] || BLUE);
      return `<div class="prab" aria-label="${ARIA[cat]}: ${c.n}" style="color:${color}"><div class="prab-icon">${ICONS[cat]}</div><div class="prab-num">${fmt(c.n)}</div></div>`;
    }).join('');
  }
  // Re-draws every badge row on the page for this user (after a heart).
  async function refreshBadges(userId) {
    await loadBadges(true);
    document.querySelectorAll(`[data-badges-for="${CSS.escape(userId)}"]`).forEach(el => mount(el, userId));
  }

  const PLAY_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,0.45)"/><path d="M9.5 7.5v9l7.5-4.5Z" fill="#fff"/></svg>';
  const HEART_OUTLINE = '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 20s-7-4.3-9-8.6C1.5 8.2 3.6 5 6.8 5c2 0 3.4 1.2 4.2 2.4.9-1.2 2.3-2.4 4.2-2.4 3.2 0 5.3 3.2 3.8 6.4C17 15.7 12 20 12 20Z"/></svg>';

  // Videos only get a src once they're near the screen, and pause when they
  // scroll away -- one shared observer per page.
  const mediaObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      const v = e.target.querySelector('video');
      if (e.isIntersecting) {
        if (!v.src && v.dataset.src) { v.src = v.dataset.src; v.preload = 'metadata'; }
      } else if (!v.paused) {
        v.pause();
      }
    });
  }, { rootMargin: '400px 0px' });
  // Autoplay on scroll: a video that's at least 60% on screen plays (muted --
  // browsers only allow muted autoplay), and pauses once it scrolls away. A
  // video the person paused by tapping stays paused until they tap again.
  const autoplayObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      const v = e.target.querySelector('video');
      if (e.isIntersecting && e.intersectionRatio >= 0.6) {
        if (v.dataset.userPaused === '1') return;
        if (!v.src && v.dataset.src) v.src = v.dataset.src;
        v.muted = true;
        document.querySelectorAll('.pra-feed video').forEach(o => { if (o !== v && !o.paused) o.pause(); });
        v.play().catch(() => {});
      } else if (!v.paused) {
        v.pause();
      }
    });
  }, { threshold: [0, 0.6] });

  function feedItemHtml(v) {
    const date = new Date(v.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `<div class="pra-feed-item" data-id="${esc(v.id)}">
      <div class="pra-feed-media">
        <video playsinline loop muted data-src="/api/chat/media/${encodeURIComponent(v.driveFileId)}#t=0.1"></video>
        <div class="pra-feed-play">${PLAY_SVG}</div>
        <div class="pra-feed-burst">${ICONS.hearts}</div>
      </div>
      <div class="pra-feed-meta">
        <button class="pra-feed-heart${v.likedByMe ? ' liked' : ''}" aria-label="Heart">${v.likedByMe ? ICONS.hearts : HEART_OUTLINE}<span>${v.likes}</span></button>
        <span class="pra-feed-date">${date}</span>
      </div>
    </div>`;
  }

  async function setLike(item, like, ownerId) {
    const btn = item.querySelector('.pra-feed-heart');
    const r = await fetch(`/api/chat/moves/${encodeURIComponent(item.dataset.id)}/like`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ like }),
    });
    if (!r.ok) return;
    const d = await r.json();
    btn.classList.toggle('liked', d.likedByMe);
    btn.innerHTML = (d.likedByMe ? ICONS.hearts : HEART_OUTLINE) + `<span>${d.likes}</span>`;
    refreshBadges(ownerId);
  }

  function wireItem(item, ownerId) {
    mediaObserver.observe(item);
    autoplayObserver.observe(item);
    const media = item.querySelector('.pra-feed-media');
    const video = item.querySelector('video');
    const burst = item.querySelector('.pra-feed-burst');
    video.addEventListener('play', () => media.classList.add('playing'));
    video.addEventListener('pause', () => media.classList.remove('playing'));
    // Single tap = play/pause (after a short wait so a double tap doesn't
    // also toggle playback); double tap = heart / un-heart.
    let tapTimer = null;
    media.addEventListener('click', () => {
      if (tapTimer) {
        clearTimeout(tapTimer); tapTimer = null;
        // Double tap toggles: hearts it (with the burst), or un-hearts it.
        const liked = item.querySelector('.pra-feed-heart').classList.contains('liked');
        if (!liked) { burst.classList.remove('show'); void burst.offsetWidth; burst.classList.add('show'); }
        setLike(item, !liked, ownerId);
        return;
      }
      tapTimer = setTimeout(() => {
        tapTimer = null;
        if (!video.src && video.dataset.src) video.src = video.dataset.src;
        if (video.paused) {
          video.dataset.userPaused = '';
          video.muted = false; // a tap is a user gesture, so sound is allowed
          document.querySelectorAll('.pra-feed video').forEach(o => { if (o !== video && !o.paused) o.pause(); });
          video.play().catch(() => {});
        } else { video.dataset.userPaused = '1'; video.pause(); }
      }, 260);
    });
    item.querySelector('.pra-feed-heart').onclick = () => {
      setLike(item, !item.querySelector('.pra-feed-heart').classList.contains('liked'), ownerId);
    };
  }

  async function mountMoves(el, userId) {
    if (!el || !userId) return;
    el.classList.add('pra-moves');
    el.innerHTML = '<div class="pra-moves-empty">Loading moves…</div>';
    const PAGE = 6;
    let offset = 0, total = 0, loading = false;
    async function fetchPage() {
      const r = await fetch(`/api/chat/user-moves/${encodeURIComponent(userId)}?offset=${offset}&limit=${PAGE}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      return d;
    }
    let first;
    try { first = await fetchPage(); } catch { el.innerHTML = ''; return null; }
    total = first.total;
    const toggle = first.isSelf
      ? `<label class="pra-moves-toggle"><span>${first.showMoves ? 'Show all your moves' : 'Keep my moves private'}</span><input type="checkbox" ${first.showMoves ? 'checked' : ''}/></label>`
      : '';
    let body;
    if (first.hidden) body = '<div class="pra-moves-empty">Moves are private.</div>';
    else if (!total) body = '<div class="pra-moves-empty">No moves uploaded yet.</div>';
    else body = '<div class="pra-feed"></div><div class="pra-feed-sentinel"></div>';
    el.innerHTML = `<div class="pra-moves-head"><span class="pra-moves-title">Moves (${first.hidden ? 0 : total})</span>${toggle}</div>${body}`;

    const cb = el.querySelector('.pra-moves-toggle input');
    if (cb) cb.onchange = async () => {
      const r = await fetch('/api/chat/me/show-moves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ show: cb.checked }) });
      if (r.ok) cb.previousElementSibling.textContent = cb.checked ? 'Show all your moves' : 'Keep my moves private';
      else cb.checked = !cb.checked;
    };
    if (first.hidden || !total) return first.owner;

    const feed = el.querySelector('.pra-feed');
    const sentinel = el.querySelector('.pra-feed-sentinel');
    function append(videos) {
      const tmp = document.createElement('div');
      tmp.innerHTML = videos.map(feedItemHtml).join('');
      [...tmp.children].forEach(item => { feed.appendChild(item); wireItem(item, userId); });
      offset += videos.length;
    }
    append(first.videos);
    const more = new IntersectionObserver(async entries => {
      if (!entries[0].isIntersecting || loading || offset >= total) return;
      loading = true;
      try { append((await fetchPage()).videos); } catch {}
      loading = false;
      if (offset >= total) more.disconnect();
    }, { rootMargin: '600px 0px' });
    more.observe(sentinel);
    return first.owner;
  }


  // Profile panel any page can open: avatar, name, role, badges, moves feed.
  // Close X top right, tap outside, or the back button.
  let modal = null;
  function closeProfile(fromBack) {
    if (!modal || !modal.classList.contains('show')) return;
    if (!fromBack && window.PRABack) PRABack.closed('prabProfile');
    modal.classList.remove('show');
    modal.querySelectorAll('video').forEach(v => v.pause());
  }
  async function openProfile(userId, fallbackName) {
    if (!userId && !fallbackName) return;
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'prab-modal';
      modal.innerHTML = `<div class="pra-panel prab-modal-box">
        <div class="pra-close-x-wrap"><button class="pra-close-x" aria-label="Close"><svg viewBox="0 0 14 14"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
        <div class="pra-avatar prab-modal-avatar"></div>
        <div class="pra-h2 prab-modal-name" style="margin-bottom:4px"></div>
        <div class="prab-modal-role" style="margin-bottom:6px"></div>
        <div class="prab-modal-badges"></div>
        <div class="prab-modal-moves"></div>
      </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) closeProfile(); });
      modal.querySelector('.pra-close-x').onclick = () => closeProfile();
    }
    modal.querySelector('.prab-modal-name').textContent = '';
    modal.querySelector('.prab-modal-role').innerHTML = '';
    modal.querySelector('.prab-modal-avatar').innerHTML = '';
    modal.classList.add('show');
    if (window.PRABack) PRABack.push('prabProfile', () => closeProfile(true));
    mount(modal.querySelector('.prab-modal-badges'), userId);
    if (!userId) {
      modal.querySelector('.prab-modal-name').textContent = fallbackName;
      modal.querySelector('.prab-modal-avatar').textContent = (fallbackName || '?')[0].toUpperCase();
      modal.querySelector('.prab-modal-moves').innerHTML = '<div class="pra-moves-empty" style="text-align:center;margin-top:14px">Not on the app yet.</div>';
      return;
    }
    const owner = await mountMoves(modal.querySelector('.prab-modal-moves'), userId);
    if (owner) {
      modal.querySelector('.prab-modal-name').textContent = [owner.first, owner.last].filter(Boolean).join(' ');
      modal.querySelector('.prab-modal-role').innerHTML = `<span class="role-tag role-tag-${esc(owner.role)}">${esc(owner.role)}</span>`;
      modal.querySelector('.prab-modal-avatar').innerHTML = owner.profilePictureFileId
        ? `<img src="/api/chat/media/${encodeURIComponent(owner.profilePictureFileId)}"/>`
        : esc((owner.first || '?')[0].toUpperCase());
    }
  }

  window.PRABadges = { mount, mountMoves, openProfile };
})();
