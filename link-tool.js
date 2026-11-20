// Link tool for automated-message boxes (Admin Panel). Any <textarea
// data-linktool> gets a "Link" button: highlight words, pick an app page (or
// type a URL) and the words become [words](url) -- chat shows that as the
// words, clickable (chat.html MD_LINK_RE). A preview under the box shows how
// it will read. {{userId}} is filled in per person by the server, so "Their
// Training Protocol" opens each person's own protocol.
(function () {
  const ORIGIN = location.origin;
  const LINKS = [
    { label: 'Quick Start game', path: '/chat-app/chat.html?tutorial=1' },
    { label: 'Their Training Protocol', path: '/chat-app/training-protocol.html?userId={{userId}}' },
    { label: 'Levels', path: '/chat-app/levels.html' },
    { label: 'Body Mastery Builder', path: '/chat-app/body-scan.html' },
    { label: 'Training Videos', path: '/chat-app/moves-dictionary.html' },
    { label: 'Training Personality Quiz', path: '/personality-quiz/index.html' },
    { label: 'Strength Ninjas Map', path: '/chat-app/users-map.html' },
    { label: 'Their Profile', path: '/chat-app/profile.html' },
    { label: 'Shop', path: '/chat-app/shop.html' },
    { label: 'Retreats', path: '/chat-app/retreats.html' },
  ];
  const MD = /\[([^\]\n]{1,160})\]\((https?:\/\/[^\s)<]+)\)/g;
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const css = document.createElement('style');
  css.textContent = `
    .lt-bar { display:flex; align-items:center; gap:10px; margin-top:6px; flex-wrap:wrap; position:relative; }
    .lt-btn { font-size:.74rem; padding:6px 12px; }
    .lt-hint { font-size:.72rem; color:var(--pra-gray, #8a8a95); }
    .lt-preview { margin-top:6px; font-size:.82rem; line-height:1.45; color:#cfd3dc; white-space:pre-wrap; word-break:break-word; }
    .lt-preview:empty { display:none; }
    .lt-preview a { color:#009bff; text-decoration:underline; }
    .lt-pop { position:absolute; top:calc(100% + 6px); left:0; z-index:50; width:min(340px, calc(100vw - 32px)); background:#15151b; border:1px solid #2a2a33; border-radius:12px; padding:8px; box-shadow:0 10px 30px rgba(0,0,0,.55); }
    .lt-pop h4 { margin:4px 6px 6px; font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; color:#8a8a95; font-weight:600; }
    .lt-item { display:block; width:100%; text-align:left; background:none; border:0; color:#fff; padding:8px 10px; border-radius:8px; cursor:pointer; font:inherit; font-size:.85rem; }
    .lt-item:hover, .lt-item:focus { background:#22222b; outline:none; }
    .lt-item small { display:block; color:#6f7380; font-size:.7rem; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .lt-custom { display:flex; gap:6px; padding:8px 6px 4px; border-top:1px solid #2a2a33; margin-top:6px; }
    .lt-custom input { flex:1; min-width:0; }
    .lt-msg { font-size:.72rem; color:#ff8a8a; padding:2px 6px; }
  `;
  document.head.appendChild(css);

  function renderPreview(ta, box) {
    const v = ta.value;
    if (!MD.test(v)) { box.innerHTML = ''; return; }
    MD.lastIndex = 0;
    let out = '', last = 0, m;
    while ((m = MD.exec(v))) { out += esc(v.slice(last, m.index)) + `<a href="${esc(m[2].replace('{{userId}}', 'me'))}" target="_blank" rel="noopener">${esc(m[1])}</a>`; last = m.index + m[0].length; }
    MD.lastIndex = 0;
    box.innerHTML = '<span class="lt-hint">Shows as: </span>' + out + esc(v.slice(last));
  }

  function mount(ta) {
    if (ta.dataset.ltMounted) return;
    ta.dataset.ltMounted = '1';
    const bar = document.createElement('div');
    bar.className = 'lt-bar';
    bar.innerHTML = `<button type="button" class="pra-btn pra-btn-ghost lt-btn">Link</button><span class="lt-hint">Highlight words, then Link.</span>`;
    const preview = document.createElement('div');
    preview.className = 'lt-preview';
    ta.after(bar, preview);
    renderPreview(ta, preview);
    ta.addEventListener('input', () => renderPreview(ta, preview));
    let sel = { start: 0, end: 0 };
    const remember = () => { sel = { start: ta.selectionStart, end: ta.selectionEnd }; };
    ['select', 'keyup', 'mouseup', 'blur'].forEach(ev => ta.addEventListener(ev, remember));
    const btn = bar.querySelector('.lt-btn');
    btn.addEventListener('mousedown', remember);
    btn.addEventListener('click', () => {
      const open = bar.querySelector('.lt-pop');
      if (open) { open.remove(); return; }
      document.querySelectorAll('.lt-pop').forEach(p => p.remove());
      const words = ta.value.slice(sel.start, sel.end).trim();
      const pop = document.createElement('div');
      pop.className = 'lt-pop';
      pop.innerHTML = `<h4>${words ? `Link “${esc(words.slice(0, 40))}${words.length > 40 ? '…' : ''}” to` : 'Highlight words in the message first'}</h4>`
        + LINKS.map((l, i) => `<button type="button" class="lt-item" data-i="${i}">${esc(l.label)}<small>${esc(l.path)}</small></button>`).join('')
        + `<div class="lt-custom"><input class="pra-input" placeholder="Or type a link: https://…" /><button type="button" class="pra-btn lt-btn">Add</button></div><div class="lt-msg"></div>`;
      bar.appendChild(pop);
      const msg = pop.querySelector('.lt-msg');
      const apply = (url) => {
        if (!words) { msg.textContent = 'Highlight the words to turn into a link first.'; return; }
        // Keep spaces that were highlighted outside the link.
        const raw = ta.value.slice(sel.start, sel.end);
        const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
        const link = `${lead}[${words.replace(/[\[\]]/g, '')}](${url})${trail}`;
        ta.value = ta.value.slice(0, sel.start) + link + ta.value.slice(sel.end);
        const caret = sel.start + link.length;
        pop.remove();
        ta.focus(); ta.setSelectionRange(caret, caret);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      };
      pop.querySelectorAll('.lt-item').forEach(b => b.addEventListener('click', () => apply(ORIGIN + LINKS[+b.dataset.i].path)));
      const inp = pop.querySelector('.lt-custom input');
      const addCustom = () => {
        let u = inp.value.trim();
        if (!u) { msg.textContent = 'Type a link first.'; return; }
        if (u.startsWith('/')) u = ORIGIN + u;
        else if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        if (/\s/.test(u)) { msg.textContent = 'A link can’t have spaces.'; return; }
        apply(u);
      };
      pop.querySelector('.lt-custom .lt-btn').addEventListener('click', addCustom);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
    });
  }
  document.addEventListener('mousedown', e => { if (!e.target.closest('.lt-bar')) document.querySelectorAll('.lt-pop').forEach(p => p.remove()); });
  const scan = () => document.querySelectorAll('textarea[data-linktool]').forEach(mount);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
