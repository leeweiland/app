// auth-keyboard.js -- keeps the sign-in / sign-up / reset-password fields
// above the on-screen keyboard (login.html, reset-password.html).
//
// The iPhone app runs with page scrolling off (capacitor ios.scrollEnabled:
// false) and the Oct 29 fix relied on iOS shrinking the view when the
// keyboard opened so .pra-root could scroll -- on the store build it doesn't,
// so the keyboard just covered the form (Lee had to pinch-zoom out to log in).
// Now the page makes the room itself: pad .pra-root by the keyboard's height
// and scroll the focused field into the space that's still visible. If the
// view DOES also shrink natively, the padding is only extra blank scroll room.
(function () {
  const root = document.querySelector('.pra-root');
  if (!root) return;

  const style = document.createElement('style');
  // 16px+ text in fields stops iPhone from auto-zooming into a tapped field
  // (that zoom is what pushed the form sideways, out of reach).
  style.textContent =
    '.pra-root input, .pra-root select, .pra-root textarea { font-size: 16px !important; }' +
    '.pra-root { padding-bottom: var(--auth-kb, 0px); }';
  document.head.appendChild(style);

  let kb = 0;
  const setKb = (px) => {
    kb = Math.max(0, Math.round(px || 0));
    document.documentElement.style.setProperty('--auth-kb', kb + 'px');
  };

  // How much of the window is still visible above the keyboard.
  function visibleHeight() {
    const vv = window.visualViewport;
    const native = vv ? vv.height : window.innerHeight;
    // If the view shrank natively, innerHeight already excludes the keyboard;
    // otherwise subtract the keyboard height the plugin reported.
    const shrunk = screen.height - window.innerHeight > 120;
    return Math.min(native, shrunk ? window.innerHeight : window.innerHeight - kb);
  }

  function revealFocused() {
    const el = document.activeElement;
    if (!el || !el.matches('input, select, textarea')) return;
    window.scrollTo(0, 0); // iOS sometimes shifts the pinned page itself
    const r = el.getBoundingClientRect();
    const target = Math.max(16, visibleHeight() / 2 - r.height / 2);
    root.scrollTop += r.top - target;
  }

  const Keyboard = window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.Keyboard;
  if (Keyboard) {
    Keyboard.addListener('keyboardWillShow', (info) => { setKb(info?.keyboardHeight); setTimeout(revealFocused, 50); });
    Keyboard.addListener('keyboardDidShow', (info) => { setKb(info?.keyboardHeight); revealFocused(); });
    Keyboard.addListener('keyboardWillHide', () => setKb(0));
  } else if (window.visualViewport) {
    // Plain mobile browser: measure what the keyboard covers.
    const vv = window.visualViewport;
    const measure = () => setKb(window.innerHeight - vv.height - vv.offsetTop);
    vv.addEventListener('resize', () => { measure(); revealFocused(); });
  }

  document.addEventListener('focusin', (e) => {
    if (!e.target.matches('input, textarea, select')) return;
    setTimeout(revealFocused, 350);
  });

  // Tapping anywhere that isn't a field closes the keyboard.
  document.addEventListener('touchstart', (e) => {
    const a = document.activeElement;
    if (!a || !a.matches('input, textarea, select')) return;
    if (e.target.closest('input, textarea, select, label, button, .pw-toggle')) return;
    a.blur();
  }, { passive: true });

  // The show-password eye: tapping it used to pull focus off the password
  // box (keyboard dropped mid-zoom and the page got stuck zoomed in). Keep
  // the box focused so the keyboard just stays put.
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    let hadFocus = false;
    btn.addEventListener('pointerdown', () => {
      hadFocus = document.activeElement === document.getElementById(btn.dataset.target);
    });
    btn.addEventListener('mousedown', (e) => { if (hadFocus) e.preventDefault(); });
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (hadFocus && input && document.activeElement !== input) input.focus();
      hadFocus = false;
    });
  });

  // Return/Go jumps to the next box; on the last one it submits as usual
  // and the keyboard closes.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.form) return;
    const fields = [...el.form.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), select, textarea')]
      .filter((f) => !f.disabled && f.offsetParent !== null);
    const i = fields.indexOf(el);
    if (i >= 0 && i < fields.length - 1) {
      e.preventDefault();
      fields[i + 1].focus();
    } else {
      el.blur();
    }
  });
})();
