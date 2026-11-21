// Dark dropdown menus for the whole app (Lee, 2026-11-21: "make the
// dropdowns matching styling" -- the browser's own <select> list opens as a
// gray/white system panel on Windows and Android).
//
// 1. PRAMenu.open(anchor, { items, multi, onPick, align }) -- a small dark
//    menu under (or above) any button, always kept inside the screen.
// 2. Every <select> in the app opens PRAMenu instead of the browser's list.
//    The real <select> stays in the page (value, onchange, forms all work as
//    before) -- only the popup is replaced. Opt out with data-native="1".
(() => {
  if (window.PRAMenu) return;

  const css = `
    .pra-menu { font-family: var(--font-primary, "Century Gothic", Poppins, sans-serif); position: fixed; z-index: 100000; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(60vh, 420px); overflow-y: auto; overscroll-behavior: contain; padding: 5px; border-radius: 12px; background: #15161b; border: 1px solid #2b2d36; box-shadow: 0 10px 30px rgba(0,0,0,.55); scrollbar-width: thin; scrollbar-color: #2b2d36 transparent; }
    .pra-menu button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-radius: 8px; background: none; color: #d6d9de; font: inherit; font-size: .82rem; font-weight: 400; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pra-menu button:hover, .pra-menu button.kb { background: rgba(0,155,255,.12); color: #fff; }
    .pra-menu button.sel { color: #009bff; }
    .pra-menu button:disabled { opacity: .4; cursor: default; background: none; }
    .pra-menu .pm-check { width: 16px; height: 16px; flex-shrink: 0; border: 1.5px solid #4a4d58; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; }
    .pra-menu button.sel .pm-check { border-color: #009bff; background: #009bff; }
    .pra-menu .pm-group { padding: 8px 10px 4px; font-size: .68rem; letter-spacing: .06em; text-transform: uppercase; color: #6b6f7a; }
    .pra-menu .pm-sep { height: 1px; margin: 4px 6px; background: #2b2d36; }
  `;
  const st = document.createElement('style');
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let current = null; // { el, anchor, close }

  function close() {
    if (!current) return;
    const c = current; current = null;
    c.el.remove();
    document.removeEventListener('pointerdown', c.away, true);
    document.removeEventListener('keydown', c.key, true);
    window.removeEventListener('resize', c.onResize);
    window.removeEventListener('scroll', c.onScroll, true);
    c.onClose?.();
  }

  // items: [{ value, label, selected, disabled, group, separator }]
  function open(anchor, opts) {
    if (current && current.anchor === anchor) { close(); return; }
    close();
    const { multi = false, onPick, onClose, align = 'left' } = opts;
    let items = opts.items || [];
    const el = document.createElement('div');
    el.className = 'pra-menu';
    el.setAttribute('role', 'listbox');
    const draw = () => {
      let lastGroup = null;
      el.innerHTML = items.map((it, i) => {
        if (it.separator) return '<div class="pm-sep"></div>';
        let head = '';
        if (it.group && it.group !== lastGroup) { head = `<div class="pm-group">${esc(it.group)}</div>`; lastGroup = it.group; }
        return head + `<button type="button" role="option" data-i="${i}" class="${it.selected ? 'sel' : ''}"${it.disabled ? ' disabled' : ''}>${multi ? `<span class="pm-check">${it.selected ? CHECK : ''}</span>` : ''}<span style="overflow:hidden;text-overflow:ellipsis">${esc(it.label)}</span></button>`;
      }).join('');
      el.querySelectorAll('button[data-i]').forEach(b => b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const it = items[Number(b.dataset.i)];
        if (!it || it.disabled) return;
        const next = onPick?.(it);
        if (multi) { if (Array.isArray(next)) { items = next; const top = el.scrollTop; draw(); el.scrollTop = top; } }
        else close();
      });
    };
    draw();
    document.body.appendChild(el);
    const place = () => {
      const r = anchor.getBoundingClientRect();
      el.style.minWidth = Math.max(160, Math.min(r.width, window.innerWidth - 16)) + 'px';
      const w = el.offsetWidth, h = el.offsetHeight;
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      const below = r.bottom + 6 + h <= window.innerHeight - 8;
      const top = below ? r.bottom + 6 : Math.max(8, r.top - 6 - h);
      el.style.left = left + 'px'; el.style.top = top + 'px';
    };
    place();
    const sel = el.querySelector('button.sel');
    if (sel && !multi) sel.scrollIntoView({ block: 'center' });
    const away = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    const key = (e) => {
      const btns = [...el.querySelectorAll('button[data-i]:not(:disabled)')];
      let i = btns.findIndex(b => b.classList.contains('kb'));
      if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus?.(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (i < 0) i = btns.findIndex(b => b.classList.contains('sel'));
        btns.forEach(b => b.classList.remove('kb'));
        i = e.key === 'ArrowDown' ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1);
        btns[i]?.classList.add('kb'); btns[i]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); btns[i].click(); }
    };
    const onResize = () => close();
    const onScroll = (e) => { if (!el.contains(e.target)) close(); };
    current = { el, anchor, close, away, key, onResize, onScroll, onClose };
    setTimeout(() => {
      if (current?.el !== el) return;
      document.addEventListener('pointerdown', away, true);
      document.addEventListener('keydown', key, true);
      window.addEventListener('resize', onResize);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
    return el;
  }

  window.PRAMenu = { open, close, isOpen: () => !!current };

  // ── <select> takeover ───────────────────────────────────────────────────
  const usable = (s) => s && s.tagName === 'SELECT' && !s.multiple && !(s.size > 1) && !s.disabled && s.dataset.native !== '1';
  function openForSelect(s) {
    const items = [];
    for (const node of s.children) {
      if (node.tagName === 'OPTGROUP') {
        for (const o of node.children) if (!o.hidden) items.push({ value: o.value, label: o.text, selected: o.selected, disabled: o.disabled || node.disabled, group: node.label, opt: o });
      } else if (node.tagName === 'OPTION' && !node.hidden) {
        items.push({ value: node.value, label: node.text, selected: node.selected, disabled: node.disabled, opt: node });
      }
    }
    if (!items.length) return;
    s.classList.add('pra-select-open');
    open(s, {
      items,
      onClose: () => s.classList.remove('pra-select-open'),
      onPick: (it) => {
        if (it.opt.selected) return;
        it.opt.selected = true;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  }
  // Desktop: the browser opens its list on mousedown. Phones: on the tap.
  document.addEventListener('mousedown', (e) => {
    const s = e.target.closest?.('select');
    if (!usable(s) || e.button !== 0) return;
    e.preventDefault();
    s.focus({ preventScroll: true });
    openForSelect(s);
  }, true);
  let touchStart = null;
  document.addEventListener('touchstart', (e) => {
    const s = e.target.closest?.('select');
    touchStart = usable(s) ? { s, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', (e) => {
    const t = touchStart; touchStart = null;
    if (!t) return;
    const p = e.changedTouches[0];
    if (Math.hypot(p.clientX - t.x, p.clientY - t.y) > 10) return; // a scroll, not a tap
    e.preventDefault(); // stops the phone's own picker
    openForSelect(t.s);
  }, { capture: true, passive: false });
  // Keyboard: Enter / Space / Alt+Down open it too (arrows alone still step through).
  document.addEventListener('keydown', (e) => {
    const s = e.target;
    if (!usable(s) || current) return;
    if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown') || e.key === 'F4') { e.preventDefault(); openForSelect(s); }
  }, true);
})();
