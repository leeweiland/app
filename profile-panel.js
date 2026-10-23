// The ONE profile panel, used everywhere a person's profile opens: chat
// sidebar icon, chat thread name, training protocol name, your own profile
// page, the map, and the Levels page. Ported from chat.html's original
// Levels modal so every place shows literally the same thing.
//
//   PRAProfile.open(userOrId, { showMoves })     -> modal (close X / tap out / back)
//   PRAProfile.renderInline(el, userOrId, opts)  -> same panel content, embedded
//
// userOrId: a user object ({ id, first, last, role, profilePictureFileId, ... }),
// a user id, or for a Levels-sheet person with no app account { first, last }.
// Needs pra-badges.js (badges + moves feed) and chat-header.js (PRABack).
(function () {
  const LEVELS_NUMERIC_CATS = ['NINJA STRENGTH', 'HANDSTAND', 'POWERMOVES', 'FREERUN', 'CIRQUE'];
  const LEVEL_NUM_COLORS = { 1: '#ffffff', 2: '#ffd700', 3: '#cd7f32', 4: '#22c55e', 5: '#3b82f6', 6: '#a855f7', 7: '#ef4444', 8: '#d1d5db', 9: '#9a9aa5', 10: '#009bff' };
  const QUICK_ROLES = ['user', 'online', 'gym'];

  const css = `
  .pp-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 650; padding: 16px; box-sizing: border-box; }
  .pp-backdrop.show { display: flex; }
  .pp-backdrop *, .pp-inline * { box-sizing: border-box; }
  .pp-box { width: 100%; max-width: 560px; max-height: 88vh; max-height: 88dvh; overflow-y: auto; overflow-x: hidden; padding: 22px; text-align: center; color: var(--pra-white, #fff); font-family: var(--font-primary, inherit); }
  .pp-inline { text-align: center; color: var(--pra-white, #fff); }
  .pp-avatar-wrap { position: relative; width: 80px; margin: 0 auto 12px; }
  .pp-avatar { width: 80px; height: 80px; font-size: 1.7rem; margin: 0; }
  .pp-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .pp-avatar-edit { position: absolute; top: -2px; right: -2px; width: 26px; height: 26px; border-radius: 50%; background: #12121f; border: 1.5px solid var(--pra-border); display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .pp-avatar-edit:hover { border-color: var(--pra-blue); }
  .pp-avatar-edit svg { width: 13px; height: 13px; }
  .pp-name-row { display: flex; align-items: center; justify-content: center; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; }
  .pp-name { margin-bottom: 0; color: #fff; }
  .pp-name-edit-btn { background: none; border: none; color: var(--pra-dim); cursor: pointer; font-size: .82rem; padding: 2px 5px; border-radius: 4px; }
  .pp-name-edit-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
  .pp-name-input { width: 90px; padding: 4px 8px; font-size: .85rem; }
  .pp-name-save, .pp-name-cancel { padding: 4px 10px; font-size: .78rem; }
  .pp-location { font-size: .85rem; margin-bottom: 10px; }
  .pp-actions { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .pp-body { text-align: left; }
  .pp-archetype { text-decoration: none; display: block; width: 100%; }
  .pp-archetype:hover .pp-chip { border-color: var(--pra-blue); }
  .pp-program { margin-bottom: 10px; }
  .pp-super { font-family: var(--font-secondary); font-size: .64rem; letter-spacing: .05em; text-transform: uppercase; color: var(--pra-dim); margin-bottom: 6px; }
  .pp-super .num { color: #009bff; font-weight: 700; font-size: .8rem; }
  .pp-col { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
  .pp-chip { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.03); border: 1px solid var(--pra-border); border-radius: 7px; padding: 5px 10px; font-size: .72rem; width: 100%; color: #fff; }
  .pp-chip .cat { font-family: var(--font-secondary); font-size: .62rem; color: var(--pra-dim); text-transform: uppercase; letter-spacing: .04em; flex: 1; }
  .pp-chip .cat.sized { flex: 0 0 auto; display: inline-grid; }
  .pp-chip .cat.sized > span, .pp-chip .cat.sized::after { grid-area: 1 / 1; }
  .pp-chip .cat.sized::after { content: "Ninja Strength"; visibility: hidden; }
  .pp-chip .chip-val { font-weight: 700; white-space: nowrap; }
  .pp-chip .chip-val.editable { cursor: pointer; border-radius: 5px; padding: 2px 6px; transition: background .15s; }
  .pp-chip .chip-val.editable:hover { background: rgba(0,155,255,0.15); }
  .pp-stripes { display: flex; gap: 3px; align-items: center; margin-left: 12px; margin-right: auto; }
  .pp-stripes i { width: 10px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.07); }
  .pp-stripes i.on { background: #009bff; }
  .pp-chip-input { width: 40px; font-size: .72rem; font-weight: 700; background: rgba(255,255,255,0.06); border: 1px solid var(--pra-blue); border-radius: 5px; color: #fff; text-align: center; padding: 2px 4px; }
  .pp-team-box { display: inline-block; width: 14px; height: 14px; border: 1.5px solid var(--pra-dim); border-radius: 4px; vertical-align: middle; }
  .pp-quota { display: inline-block; font-family: var(--font-secondary); font-size: .66rem; font-weight: 700; color: var(--pra-dim); background: rgba(255,255,255,0.06); border: 1px solid var(--pra-border); border-radius: 999px; padding: 1px 6px; white-space: nowrap; margin-left: 6px; vertical-align: middle; }
  .pp-msg { font-size: .78rem; margin-top: 8px; min-height: 1em; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── helpers ──────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const catLabel = (c) => c.toLowerCase().replace(/(^|\s)\S/g, t => t.toUpperCase());
  const isChecked = (v) => ['x', 'yes'].includes(String(v || '').trim().toLowerCase());
  const numColor = (n) => LEVEL_NUM_COLORS[Number(n)] || '#5f727f';
  const isClientRole = (r) => r === 'online' || r === 'gym';
  const initials = (u) => ((u?.first?.[0] || '') + (u?.last?.[0] || '')).toUpperCase();
  const avatarHtml = (u) => u?.profilePictureFileId ? `<img src="/api/chat/media/${esc(u.profilePictureFileId)}"/>` : esc(initials(u));
  function avatarRoleClass(u) {
    if (!u?.role) return '';
    const role = u.role === 'admin2' ? 'admin' : u.role;
    return ' role-' + role + (isClientRole(role) ? '-solo' : '');
  }
  function roleBadgeHtml(u) {
    const map = { admin: 'Admin', admin2: 'Admin', coach: 'Coach', online: 'Online', gym: 'Gym', user: 'User' };
    if (!map[u?.role]) return '';
    const cls = u.role === 'admin2' ? 'admin' : u.role;
    return `<span class="role-tag role-tag-${cls}">${map[u.role]}</span>`;
  }
  const slugify = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const archetypeUrl = (title, gender) => `/personality-quiz/results.html?title=${encodeURIComponent(slugify(title))}&gender=${encodeURIComponent(gender || 'male')}`;
  const stripes = (n) => `<span class="pp-stripes">${Array.from({ length: 10 }, (_, i) => `<i${i < n ? ' class="on"' : ''}></i>`).join('')}</span>`;
  function effectiveLevel(entry, cat) {
    const raw = Number(entry?.levels?.[cat]) || 0;
    if (raw > 0) return raw;
    return entry && isChecked(entry.levels['FOUNDATION']) ? 1 : 0;
  }
  const alertBox = (m) => (typeof window.alertDialog === 'function' ? window.alertDialog(m) : Promise.resolve(alert(m)));
  const confirmBox = (m, ok) => (typeof window.confirmDialog === 'function' ? window.confirmDialog(m, ok) : Promise.resolve(confirm(m)));
  // Let the host page refresh anything that shows names/roles (chat's sidebar).
  const notifyChanged = () => { try { if (typeof window.loadConversations === 'function') window.loadConversations(); } catch {} };

  let mePromise = null;
  function getMe(force) {
    if (!mePromise || force) mePromise = fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => d?.user || null).catch(() => null);
    return mePromise;
  }
  const isAdmin = (me) => !!me && (me.role === 'admin' || me.role === 'admin2');
  const isStaff = (me) => !!me && (me.role === 'coach' || isAdmin(me));
  let quotaPromise = null;
  function getQuota() {
    if (!quotaPromise) quotaPromise = fetch('/api/chat/coach-monthly-stats').then(r => r.ok ? r.json() : null).catch(() => null);
    return quotaPromise;
  }

  // ── panel markup (one instance per container) ───────────────────────────
  function panelHtml(withClose) {
    return `
      ${withClose ? '<div class="pra-close-x-wrap"><button class="pra-close-x pp-close" aria-label="Close"><svg viewBox="0 0 14 14"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>' : ''}
      <div class="pp-avatar-wrap">
        <div class="pra-avatar pp-avatar"></div>
        <div class="pp-avatar-edit" title="Change profile photo" style="display:none"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20Z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M13 7l4 4" stroke="#009bff" stroke-width="1.6"/></svg></div>
        <input type="file" class="pp-pic-input" accept="image/*" style="display:none"/>
      </div>
      <div class="pp-name-row"><div class="pra-h2 pp-name"></div><button type="button" class="pp-name-edit-btn" title="Rename" style="display:none">✎</button></div>
      <div class="pp-role" style="margin-bottom:8px"></div>
      <div class="pra-muted pp-location"></div>
      <div class="pp-badges"></div>
      <div class="btn-row pp-actions"></div>
      <div class="pp-body"></div>
      <div class="pp-moves"></div>
      <div class="btn-row pp-msg-row" style="display:flex;gap:10px;margin-top:16px"><button class="pra-btn pra-btn-ghost pp-message" style="flex:1">Message</button></div>
      <div class="pra-muted pp-msg"></div>`;
  }

  // ── render one person into a panel root ──────────────────────────────────
  async function render(root, userOrId, opts) {
    const q = (sel) => root.querySelector(sel);
    const me = await getMe();
    let user = typeof userOrId === 'string' ? null : { ...userOrId };
    if (typeof userOrId === 'string') {
      const r = await fetch('/api/chat/users/' + encodeURIComponent(userOrId));
      user = r.ok ? ((await r.json()).user || null) : null;
      if (!user) { q('.pp-name').textContent = 'Not found'; return; }
    }
    const hasAccount = !!user.id;
    const isSelf = !!(me && hasAccount && user.id === me.id);
    const staff = isStaff(me);
    const state = { user, entries: [], archetype: { title: null, image: null, gender: null } };

    // header
    const av = q('.pp-avatar');
    av.className = 'pra-avatar pp-avatar' + avatarRoleClass(user);
    av.innerHTML = avatarHtml(user);
    const nameText = (staff || isSelf || !hasAccount) ? [user.first, user.last].filter(Boolean).join(' ') : user.first;
    q('.pp-name').innerHTML = esc(nameText);
    if (staff && user.role === 'coach' && user.showCoachQuota) {
      getQuota().then(st => { if (st) q('.pp-name').insertAdjacentHTML('beforeend', `<span class="pp-quota" title="Favorited/gym-cammed this month">${st.counts?.[user.id] || 0}/${st.goal}</span>`); });
    }
    const editBtn = q('.pp-name-edit-btn');
    editBtn.style.display = staff && hasAccount ? '' : 'none';
    editBtn.onclick = () => startNameEdit(root, state, opts);
    q('.pp-role').innerHTML = roleBadgeHtml(user);
    q('.pp-location').textContent = '';
    q('.pp-msg').textContent = 'Loading…';
    q('.pp-body').innerHTML = '';
    renderAccountActions(root, state, staff);

    // Message button: hidden for coaches -> students (server forbids it), for
    // yourself, and for people with no app account.
    const msgRow = q('.pp-msg-row');
    const coachCantDm = QUICK_ROLES.includes(user.role) && !isSelf && staff && !isAdmin(me);
    msgRow.style.display = (!hasAccount || isSelf || coachCantDm) ? 'none' : 'flex';
    q('.pp-message').onclick = () => {
      if (opts.onMessage) return opts.onMessage(user);
      location.href = '/chat-app/chat.html?dm=' + encodeURIComponent(user.id);
    };

    // own photo
    const editPic = q('.pp-avatar-edit');
    editPic.style.display = isSelf ? '' : 'none';
    editPic.onclick = () => q('.pp-pic-input').click();
    q('.pp-pic-input').onchange = async () => {
      const pic = q('.pp-pic-input').files[0];
      if (!pic) return;
      const fd = new FormData(); fd.append('profilePicture', pic);
      await fetch('/api/auth/update-profile', { method: 'POST', body: fd });
      const fresh = await getMe(true);
      render(root, fresh || user, opts);
    };

    // badges + moves feed
    const badgesEl = q('.pp-badges'); badgesEl.innerHTML = ''; delete badgesEl.dataset.badgesFor;
    if (window.PRABadges) PRABadges.mount(badgesEl, hasAccount ? user.id : null);
    const movesEl = q('.pp-moves'); movesEl.innerHTML = '';
    if (opts.showMoves !== false && hasAccount && window.PRABadges) PRABadges.mountMoves(movesEl, user.id);

    // profile card (location, personality) + levels
    const [profileRes, levelsRes] = await Promise.all([
      hasAccount ? fetch('/api/chat/profile/' + encodeURIComponent(user.id)) : Promise.resolve(null),
      fetch('/api/chat/levels/lookup?first=' + encodeURIComponent(user.first || '') + '&last=' + encodeURIComponent(user.last || '')),
    ]);
    const profile = profileRes && profileRes.ok ? (await profileRes.json()).profile : null;
    state.entries = levelsRes.ok ? (await levelsRes.json()).entries || [] : [];
    q('.pp-msg').textContent = '';
    const loc = profile?.location ? [profile.location.city, profile.location.region, profile.location.country].filter(Boolean).join(', ')
      : (user.location ? [user.location.city, user.location.region, user.location.country].filter(Boolean).join(', ') : '');
    q('.pp-location').textContent = loc;
    state.archetype = profile ? { title: profile.archetypeTitle, image: profile.archetypeImage, gender: profile.gender }
      : { title: user.archetypeTitle || null, image: user.archetypeImage || null, gender: user.gender || null };
    renderBody(root, state, staff);
  }

  function renderAccountActions(root, state, staff) {
    const wrap = root.querySelector('.pp-actions');
    const u = state.user;
    if (!staff || !u.id || !QUICK_ROLES.includes(u.role)) { wrap.innerHTML = ''; return; }
    const label = (r) => r === 'user' ? 'a User' : r === 'online' ? 'Online' : 'Gym';
    wrap.innerHTML = QUICK_ROLES.filter(r => r !== u.role).map(r => `<button class="pra-btn pra-btn-ghost pp-role-btn" data-role="${r}" style="flex:1;font-size:.78rem">Make ${label(r)}</button>`).join('')
      + `<button class="pra-btn pra-btn-ghost pp-archive-btn" style="flex:1;font-size:.78rem${u.archived ? '' : ';border-color:#ff5c5c;color:#ff5c5c'}">${u.archived ? 'Unarchive' : 'Archive'}</button>`;
    wrap.querySelectorAll('.pp-role-btn').forEach(btn => {
      btn.onclick = async () => {
        const r = await fetch(`/api/chat/users/${u.id}/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: btn.dataset.role }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); await alertBox(d.error || 'Could not change role.'); return; }
        u.role = (await r.json()).user.role;
        root.querySelector('.pp-role').innerHTML = roleBadgeHtml(u);
        renderAccountActions(root, state, staff);
        notifyChanged();
      };
    });
    wrap.querySelector('.pp-archive-btn').onclick = async () => {
      const next = !u.archived;
      if (next && !(await confirmBox(`Archive ${u.first} ${u.last}? They'll be logged out and unable to sign back in until unarchived.`, 'Archive'))) return;
      const r = await fetch(`/api/chat/users/${u.id}/archived`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: next }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); await alertBox(d.error || 'Could not update.'); return; }
      u.archived = (await r.json()).user.archived;
      renderAccountActions(root, state, staff);
      notifyChanged();
    };
  }

  function startNameEdit(root, state, opts) {
    const u = state.user;
    const nameEl = root.querySelector('.pp-name');
    root.querySelector('.pp-name-edit-btn').style.display = 'none';
    const mk = (val, ph) => { const i = document.createElement('input'); i.type = 'text'; i.className = 'pra-input pp-name-input'; i.value = val || ''; i.placeholder = ph; return i; };
    const fi = mk(u.first, 'First'), li = mk(u.last, 'Last');
    const save = document.createElement('button'); save.type = 'button'; save.className = 'pra-btn pp-name-save'; save.textContent = '✓';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'pra-btn pra-btn-ghost pp-name-cancel'; cancel.textContent = '✕';
    nameEl.innerHTML = ''; nameEl.append(fi, li, save, cancel);
    fi.focus(); fi.select();
    const doCancel = () => render(root, u, opts);
    const doSave = async () => {
      const nf = fi.value.trim(), nl = li.value.trim();
      if (!nf || !nl) { await alertBox('First and last name are required.'); return; }
      save.disabled = true;
      const r = await fetch('/api/chat/people/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first: u.first, last: u.last, newFirst: nf, newLast: nl, userId: u.id }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); await alertBox(d.error || 'Could not rename — try again.'); save.disabled = false; return; }
      u.first = nf; u.last = nl;
      notifyChanged();
      render(root, u, opts);
    };
    save.onclick = doSave; cancel.onclick = doCancel;
    [fi, li].forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') doCancel(); }));
  }

  function renderBody(root, state, staff) {
    const a = state.archetype;
    const personality = a.title ? `
      <a class="pp-archetype" href="${archetypeUrl(a.title, a.gender)}">
        <div class="pp-chip"><span class="cat">Training Personality</span>
          <span class="chip-val" style="display:flex;align-items:center;gap:8px;color:#fff">${esc(a.title)}${a.image ? `<img src="${esc(a.image)}" style="width:26px;height:26px;border-radius:6px;object-fit:cover;flex-shrink:0"/>` : ''}</span>
        </div>
      </a>` : '';
    const editCls = staff ? ' editable' : '';
    const programs = state.entries.map((e, idx) => {
      const foundation = isChecked(e.levels['FOUNDATION']);
      const team = !!e.team;
      return `
      <div class="pp-program">
        <div class="pp-super">${esc(e.program)} — Super Level <span class="num">${LEVELS_NUMERIC_CATS.reduce((s, c) => s + effectiveLevel(e, c), 0)}</span></div>
        <div class="pp-col">
          <div class="pp-chip"><span class="cat sized"><span>Foundation</span></span>${stripes(foundation ? 10 : 0)}<span class="chip-val${editCls}" data-idx="${idx}" data-cat="FOUNDATION" style="color:#fff">${foundation ? '✓' : 'In Progress'}</span></div>
          ${LEVELS_NUMERIC_CATS.map(cat => { const n = effectiveLevel(e, cat); return `<div class="pp-chip"><span class="cat sized"><span>${catLabel(cat)}</span></span>${stripes(n)}<span class="chip-val${editCls}" data-idx="${idx}" data-cat="${cat}"><span style="color:${numColor(n)}">${n}</span><span style="color:#009bff">/10</span></span></div>`; }).join('')}
          ${e.program === 'Gym' ? `<div class="pp-chip"><span class="cat">Team</span><span class="chip-val${editCls}${team ? '' : ' pp-team-box'}" data-idx="${idx}" data-cat="TEAM"${team ? ' style="color:#fff"' : ''}>${team ? '✓' : ''}</span></div>` : ''}
        </div>
      </div>`;
    }).join('');
    const missing = staff ? ['Gym', 'Online'].filter(p => !state.entries.some(e => e.program === p)) : [];
    const addBtns = missing.map(p => `<button class="pra-btn pra-btn-ghost pp-add-program" data-program="${p}" style="width:100%;margin-bottom:8px;font-size:.8rem">+ Add ${p} Levels</button>`).join('');
    const body = root.querySelector('.pp-body');
    body.innerHTML = `<div class="pp-col">${personality}</div>${programs}${addBtns}`;
    body.querySelectorAll('.pp-add-program').forEach(btn => btn.onclick = () => { state.entries.push({ program: btn.dataset.program, team: false, levels: {} }); renderBody(root, state, staff); });
    body.querySelectorAll('.chip-val.editable').forEach(el => el.addEventListener('click', () => editChip(root, state, staff, el)));
  }

  async function saveField(root, state, idx, cat, value) {
    const e = state.entries[idx];
    const levels = { ...e.levels };
    if (cat === 'TEAM') e.team = value; else levels[cat] = value;
    const r = await fetch('/api/chat/levels/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first: state.user.first, last: state.user.last, program: e.program, levels, team: e.team }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); root.querySelector('.pp-msg').textContent = d.error || 'Could not save — try again.'; return false; }
    e.levels = levels;
    return true;
  }
  async function editChip(root, state, staff, el) {
    const idx = Number(el.dataset.idx), cat = el.dataset.cat, e = state.entries[idx];
    if (!e) return;
    if (cat === 'FOUNDATION' || cat === 'TEAM') {
      const current = cat === 'TEAM' ? !!e.team : isChecked(e.levels['FOUNDATION']);
      const next = cat === 'TEAM' ? !current : (current ? '' : (e.program === 'Online' ? 'Yes' : 'X'));
      el.style.opacity = '.5';
      const ok = await saveField(root, state, idx, cat, next);
      el.style.opacity = '';
      if (ok) renderBody(root, state, staff);
      return;
    }
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = '10'; input.value = effectiveLevel(e, cat); input.className = 'pp-chip-input';
    el.replaceWith(input); input.focus(); input.select();
    const commit = async () => { await saveField(root, state, idx, cat, String(Math.max(0, Math.min(10, Number(input.value) || 0)))); renderBody(root, state, staff); };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.removeEventListener('blur', commit); renderBody(root, state, staff); } });
  }

  // ── modal ────────────────────────────────────────────────────────────────
  let backdrop = null;
  function close(fromBack) {
    if (!backdrop || !backdrop.classList.contains('show')) return;
    if (!fromBack && window.PRABack) PRABack.closed('praProfile');
    backdrop.classList.remove('show');
    backdrop.querySelectorAll('video').forEach(v => v.pause());
  }
  function open(userOrId, opts = {}) {
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'pp-backdrop';
      backdrop.innerHTML = `<div class="pra-panel pp-box">${panelHtml(true)}</div>`;
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      backdrop.querySelector('.pp-close').onclick = () => close();
    }
    const box = backdrop.querySelector('.pp-box');
    box.scrollTop = 0;
    backdrop.classList.add('show');
    if (window.PRABack) PRABack.push('praProfile', () => close(true));
    const o = { ...opts };
    const userMsg = o.onMessage;
    o.onMessage = (u) => { close(); if (userMsg) userMsg(u); else location.href = '/chat-app/chat.html?dm=' + encodeURIComponent(u.id); };
    return render(box, userOrId, o);
  }
  function renderInline(el, userOrId, opts = {}) {
    el.classList.add('pp-inline');
    el.innerHTML = panelHtml(false);
    return render(el, userOrId, opts);
  }

  window.PRAProfile = { open, close, renderInline };
})();
