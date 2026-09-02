// chat-header.js — persistent quick-nav bar shared across every chat-app
// page (Chat, Body Scan, Powerbatics Videos, Strength Ninjas map, Personality
// Quiz, Admin, Profile). Injected at the very top of .pra-root (or <body> as
// a fallback for pages like personality-quiz/* that don't use the pra-root
// wrapper), outside chat.html's collapsible sidebar, so it never disappears
// — including on mobile when a conversation thread is open and the sidebar
// itself gets hidden.

(function () {
  function injectStyles() {
    if (document.getElementById('chat-header-style')) return;
    const s = document.createElement('style');
    s.id = 'chat-header-style';
    s.textContent = `
      #chat-app-header {
        position: fixed;
        top: 0; left: 0; right: 0;
        z-index: 500;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        background: rgba(16,16,20,0.7);
        backdrop-filter: blur(6px);
        border-bottom: 1px solid #26262e;
      }
      #chat-app-header .cah-label { display: block; }
      #chat-app-header .cah-logo { width: 150px; height: auto; display: block; }
      #chat-app-header .cah-logo-fallback {
        font-family: var(--font-primary, sans-serif); font-weight: 700;
        font-size: 1.1rem; letter-spacing: .08em; color: #fff;
      }
      #chat-app-header .cah-icons { display: flex; gap: 8px; }
      /* Logo + full icon row no longer fit side by side on a phone-width
         screen — stacking the logo on its own centered row above a
         centered, wrapping icon row keeps every icon reachable instead of
         letting the row overflow and clip icons off the right edge. */
      @container pra-app (max-width: 640px) {
        #chat-app-header {
          flex-direction: column;
          gap: 8px;
          padding: 10px 12px;
          /* Only phones have a front-camera housing to clear (reported on
             both iOS and Android) — desktop/tablet widths never hit this
             query, so they stay at the normal 10px padding above. 48px is
             a reasonable floor for phones with a small/no cutout;
             env(safe-area-inset-top) takes over and pushes it further on
             phones with a bigger notch/punch-hole/Dynamic Island than
             that guess accounts for. */
          padding-top: max(48px, env(safe-area-inset-top));
        }
        #chat-app-header .cah-label { align-self: center; }
        #chat-app-header .cah-logo { width: 100px; }
        #chat-app-header .cah-logo-fallback { font-size: .85rem; }
        #chat-app-header .cah-icons { justify-content: center; flex-wrap: wrap; }
      }
      #chat-app-header .cah-icon {
        width: 36px; height: 36px; border-radius: 8px;
        border: 1px solid #26262e;
        background: transparent;
        display: flex; align-items: center; justify-content: center;
        text-decoration: none; transition: border-color .15s, background .15s;
      }
      #chat-app-header .cah-icon:hover, #chat-app-header .cah-icon.active {
        border-color: #009bff; background: rgba(0,155,255,0.1);
      }
      #chat-app-header .cah-icon svg {
        width: 19px; height: 19px; overflow: visible;
        filter: drop-shadow(0 0 3px rgba(255,255,255,.7));
        transition: filter .15s;
      }
      #chat-app-header .cah-icon:hover svg, #chat-app-header .cah-icon.active svg {
        filter: drop-shadow(0 0 5px rgba(0,155,255,.9)) drop-shadow(0 0 3px rgba(255,255,255,.9));
      }
      #chat-app-bottom-bar {
        position: fixed;
        bottom: var(--keyboard-inset, 0px); left: 0; right: 0;
        z-index: 500;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 16px;
        padding-bottom: max(10px, env(safe-area-inset-bottom));
        background: rgba(16,16,20,0.7);
        backdrop-filter: blur(6px);
        border-top: 1px solid #26262e;
      }
      #chat-app-bottom-bar .cah-bottom-group {
        display: flex; align-items: center; gap: 10px;
      }
      /* Same breakpoint the top bar centers under its logo at — the bottom
         bar switches from spread-to-the-edges to one centered cluster so
         both bars read as a matching pair on a phone-width screen. */
      @container pra-app (max-width: 640px) {
        #chat-app-bottom-bar { justify-content: center; flex-wrap: wrap; }
      }
      #chat-app-bottom-bar .cah-bottom-item {
        display: flex; align-items: center; justify-content: center;
        width: 44px; height: 44px;
        text-decoration: none; border-radius: 10px;
        border: 1px solid transparent; transition: border-color .15s, background .15s;
      }
      #chat-app-bottom-bar .cah-bottom-item:hover, #chat-app-bottom-bar .cah-bottom-item.active {
        border-color: #009bff; background: rgba(0,155,255,0.1);
      }
      #chat-app-bottom-bar .cah-bottom-item svg {
        width: 22px; height: 22px; overflow: visible;
        filter: drop-shadow(0 0 3px rgba(255,255,255,.7));
        transition: filter .15s;
      }
      #chat-app-bottom-bar .cah-bottom-item:hover svg, #chat-app-bottom-bar .cah-bottom-item.active svg {
        filter: drop-shadow(0 0 5px rgba(0,155,255,.9)) drop-shadow(0 0 3px rgba(255,255,255,.9));
      }
      #chat-app-bottom-bar .cah-bottom-label {
        width: auto; padding: 0 16px;
        background: #009bff; border-color: #009bff;
        font-family: var(--font-primary, inherit); font-weight: 700; font-size: .78rem;
        letter-spacing: .02em; color: #fff; white-space: nowrap;
      }
      #chat-app-bottom-bar .cah-bottom-label:hover {
        background: #0086e0; border-color: #0086e0; box-shadow: 0 0 14px rgba(0,155,255,.6);
      }

      /* Admin-only device-preview strip: pins .pra-root (which already
         contains this bar's own top/bottom bars — they're inserted as its
         children) to a fixed device size/orientation for testing, the same
         way browser devtools' device toolbar would, without needing a real
         phone or tablet on hand. The lightbox stays exempt (it lives
         outside .pra-root) since a fullscreen viewer should always reflect
         the real window, not the simulated frame. */
      #pra-device-strip {
        position: fixed; top: 0; left: 0; right: 0; z-index: 900;
        display: flex; align-items: center; gap: 6px;
        padding: 6px 10px;
        background: #0a0a12; border-bottom: 1px solid #26262e;
        font-family: var(--font-primary, sans-serif); font-size: 11px;
      }
      #pra-device-strip .pds-label { color: #666; margin-right: 4px; letter-spacing: .04em; }
      #pra-device-strip button {
        border: 1px solid #26262e; background: transparent; color: #999;
        border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 11px;
        transition: border-color .15s, color .15s, background .15s;
      }
      #pra-device-strip button:hover { color: #fff; border-color: #444; }
      #pra-device-strip button.active { color: #fff; border-color: #009bff; background: rgba(0,155,255,0.12); }

      /* The simulated device frame (1024px tall for tablet) is routinely
         taller than the real browser window it's being previewed in —
         fitDeviceFrame() (below) caps the frame's own width/height to
         whatever room is actually available, like real devtools' device
         toolbar does.
         Getting the frame to fit is only half of it, though: whatever
         content overflows that capped height still needs somewhere to go.
         It used to go through .pra-root's own "overflow: auto" — but
         .pra-root also carries the transform that makes it the containing
         block for this bar's/bottomBar's fixed positioning, and a
         transform-established containing block downgrades position:fixed
         to behave like position:absolute (per spec) — meaning those bars
         scrolled away with the rest of .pra-root's content instead of
         staying pinned, which is exactly the "nav bars drift over the page"
         bug. Fix: .pra-root itself no longer scrolls (plain "overflow:
         hidden" here); build() below moves everything between the header and
         footer bars into a dedicated #pra-device-content-wrap sibling that
         does the scrolling instead, so the fixed bars — outside that
         wrapper — are never subject to its scroll offset. */
      .pra-device-frame {
        position: fixed; top: var(--pra-device-strip-h, 33px); left: 50%;
        transform: translateX(-50%);
        display: flex; flex-direction: column;
        margin: 0; overflow: hidden;
        border: 1px solid #333; box-shadow: 0 0 0 2000px rgba(0,0,0,0.55);
        min-height: 0 !important;
      }
      .pra-device-tablet { width: 768px; height: 1024px; }
      .pra-device-mobile { width: 390px; height: 844px; }
      /* Only scrolls (and only exists at all) in device-frame mode — see the
         .pra-device-frame comment above for why. flex:1/min-height:0 lets it
         take exactly the room left over after the header/footer spacers,
         instead of growing to fit its own (likely much taller) content.
         "display: contents" is the default (i.e. applies outside device-
         frame mode, including Desktop mode for admins — this wrapper exists
         for every admin session, not just when a Tablet/Mobile preview is
         actually active) so the wrapper's own box disappears from layout
         entirely and its children act as if they were direct children of
         .pra-root again — several pages (chat.html among them) size their
         own top-level content with flex:1 against .pra-root directly, which
         broke (collapsed to content height, leaving a gap above the bottom
         bar) once this wrapper's real box sat between them. */
      #pra-device-content-wrap { display: contents; }
      .pra-device-frame #pra-device-content-wrap {
        /* flex column, not block: this wrapper stands in for .pra-root as
           the flex parent its own children (chat.html's .chat-shell among
           them) size themselves against with their own flex:1 — a plain
           block box here has no flex context at all for them to attach to,
           which was still leaving a gap in device-frame mode even after
           the desktop-mode gap (a different instance of the same underlying
           mismatch) was fixed. */
        display: flex; flex-direction: column;
        flex: 1; min-height: 0; overflow-y: auto;
      }
    `;
    document.head.appendChild(s);
  }

  // Shared icon language across the app: white line-art + a #009bff accent,
  // with a glowing white edge — see CAH_ICON_SVG usage in chat.html's
  // "New Group" button for the matching 8th icon (group), which isn't part
  // of this persistent bar.
  const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
  const ICON_SVG = {
    chat: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4.5 3.5V17H6a2 2 0 0 1-2-2V6Z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><circle cx="16.5" cy="6.5" r="2.4" fill="#009bff"/></svg>`,
    bodyScan: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><path d="M4 8V6a2 2 0 0 1 2-2h2M18 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M6 20H4a2 2 0 0 1-2-2v-2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="3" stroke="#009bff" stroke-width="1.6"/><circle cx="12" cy="12" r="0.9" fill="#009bff"/></svg>`,
    video: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><rect x="3.5" y="5" width="17" height="14" rx="2.2" stroke="#fff" stroke-width="1.6"/><path d="M6.2 5 7.8 8.2M10.6 5l1.6 3.2M15 5l1.6 3.2" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/><path d="M10.2 10.4v5.2l4.5-2.6-4.5-2.6Z" fill="#009bff"/></svg>`,
    map: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><circle cx="12" cy="12" r="8.4" stroke="#fff" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="8.4" ry="3.2" stroke="#fff" stroke-width="1.1" opacity=".65"/><path d="M12 3.6v16.8M4.6 8h14.8M4.6 16h14.8" stroke="#fff" stroke-width="1" opacity=".65"/><circle cx="14.6" cy="9.6" r="1.9" fill="#009bff" stroke="#fff" stroke-width=".6"/></svg>`,
    brain: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><path d="M12 5c-1.6-1.5-4.6-1.1-5.6 1-.7 1.4-.3 2.5-1 3.1-1.4 1.2-1.7 3.3-.6 4.8.3.4.3.9.1 1.4-.6 1.5.3 3.1 1.9 3.5.5.1.9.4 1.1.9.6 1.2 2.1 1.7 3.3 1.1.3-.1.6-.2.8-.2" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 5c1.6-1.5 4.6-1.1 5.6 1 .7 1.4.3 2.5 1 3.1 1.4 1.2 1.7 3.3.6 4.8-.3.4-.3.9-.1 1.4.6 1.5-.3 3.1-1.9 3.5-.5.1-.9.4-1.1.9-.6 1.2-2.1 1.7-3.3 1.1-.3-.1-.6-.2-.8-.2" stroke="#009bff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 5v15.6" stroke="#5f727f" stroke-width="1"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><circle cx="12" cy="12" r="3.1" stroke="#fff" stroke-width="1.6"/><path d="M19.4 13.4a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.1a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.6 1H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" stroke="#009bff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    profile: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><circle cx="12" cy="8" r="3.3" stroke="#fff" stroke-width="1.6"/><path d="M5 19.4c1.1-3.5 3.8-5.3 7-5.3s5.9 1.8 7 5.3" stroke="#009bff" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    levels: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><rect x="3.5" y="13" width="4.5" height="7" rx="1" stroke="#fff" stroke-width="1.6"/><rect x="9.75" y="8" width="4.5" height="12" rx="1" stroke="#009bff" stroke-width="1.6"/><rect x="16" y="4" width="4.5" height="16" rx="1" stroke="#fff" stroke-width="1.6"/></svg>`,
    retreats: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><path d="M10.5 14.5 3.5 12l1-1.6 8 1.4 3.7-3.7c.6-.6 1.6-.6 2.2 0 .6.6.6 1.6 0 2.2l-3.7 3.7 1.4 8-1.6 1-2.5-7-4 4 .3 2.1-1.3 1.3-1.6-2.9-2.9-1.6 1.3-1.3 2.1.3 4-4Z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round" fill="none"/><circle cx="18.5" cy="5.5" r="1.3" fill="#009bff"/></svg>`,
    shop: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><path d="M8.5 4 5 6.5 3 9l2.5 2 1.5-1.3V20h10V9.7L18.5 11 21 9l-2-2.5L15.5 4c-.5 1.7-2 2.8-3.5 2.8S9 5.7 8.5 4Z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.5 4c.5 1.7 2 2.8 3.5 2.8S15 5.7 15.5 4" stroke="#009bff" stroke-width="1.4"/></svg>`,
    protocol: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><rect x="5" y="4" width="14" height="17" rx="2" stroke="#fff" stroke-width="1.6"/><path d="M9 4V3.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 3.5V4" stroke="#fff" stroke-width="1.6"/><path d="M8.5 11.5l2 2 4-4.5" stroke="#009bff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 16.5h7" stroke="#009bff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    apply: `<svg viewBox="0 0 24 24" fill="none" ${SVG_NS}><path d="M6 3.5v17" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M6 4.5h12.5c.7 0 1 .8.5 1.3l-3.3 3.4 3.3 3.4c.5.5.2 1.3-.5 1.3H6V4.5Z" stroke="#009bff" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  };

  const ICONS = [
    { href: '/chat-app/chat.html', icon: ICON_SVG.chat, title: 'Chat' },
    { selfProtocol: true, icon: ICON_SVG.protocol, title: 'My Training Protocol' },
    { href: '/chat-app/moves-dictionary.html', icon: ICON_SVG.video, title: 'Powerbatics Training Videos' },
    { href: '/chat-app/admin-panel.html', icon: ICON_SVG.settings, title: 'Admin panel', adminOnly: true },
    { href: '/chat-app/profile.html', icon: ICON_SVG.profile, title: 'My profile' },
  ];

  // Second, bottom-anchored bar for the newer content sections — kept
  // separate from the top bar's core app nav.
  // Temporary: Physique Builder is still under active development -- only
  // this one account sees its nav icon until it's ready for everyone.
  const DEV_ONLY_USER_ID = '76f3579b-ed30-46dd-928f-42a32d269dd2'; // lee@pacificrimathletics.com
  const BOTTOM_ICONS = [
    { href: '/chat-app/body-scan.html', icon: ICON_SVG.bodyScan, title: 'Body Scan', devOnly: true },
    { href: '/chat-app/users-map.html', icon: ICON_SVG.map, title: 'Strength Ninjas' },
    { href: '/personality-quiz/index.html', icon: ICON_SVG.brain, title: 'Training Personality Quiz' },
    { href: '/chat-app/levels.html', icon: ICON_SVG.levels, title: 'Levels' },
    // Retreats icon (plane) temporarily pulled from the bottom bar — page
    // itself is untouched, just not linked from here for now.
    { href: 'https://vimfti-ev.myshopify.com/', icon: ICON_SVG.shop, title: 'Shop', external: true },
    { href: 'https://pacificrimathletics.com/online-app', label: 'APPLY FOR TRAINING', title: 'Apply for Training', external: true, plainUserOnly: true },
  ];

  // On-screen keyboards shrink the VISUAL viewport, but `position: fixed`
  // elements anchor to the real (layout) viewport unless something tells
  // them otherwise — on some Android WebView versions #chat-app-bottom-bar
  // stayed pinned to the true screen bottom while chat.html's composer
  // (sized off visualViewport directly, see its own --app-vh) correctly
  // moved up above the keyboard, landing the composer underneath this bar
  // instead of above it. Driving this bar's `bottom` off the same
  // visualViewport source keeps both in the same coordinate space.
  function setupKeyboardInsetTracking() {
    const applyInset = (px) => {
      document.documentElement.style.setProperty('--keyboard-inset', px + 'px');
      document.documentElement.style.setProperty('--app-vh', (window.innerHeight - px) + 'px');
    };
    const platform = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.getPlatform() : null;
    // iOS's WKWebView (with this project's `resize: "native"` Keyboard
    // config) already natively resizes the view when the keyboard opens —
    // that's why iOS was fine with zero JS involvement in the first place.
    // Applying an inset on top of that double-compensates: the view
    // shrinks natively AND gets shrunk again here, leaving a big blank gap
    // where the composer ends up sitting well above the keyboard. Leave
    // iOS alone entirely and trust its native behavior.
    if (platform === 'ios') return;
    // Android's native resize isn't reliably applying at all, so it needs
    // a manual inset — but window.innerHeight there is inconsistent about
    // whether it already reflects some partial native resize (varies by
    // OEM WebView), which made trusting the plugin's own keyboardHeight
    // value unreliable. visualViewport.height is a direct measurement of
    // what's actually visible right now, sidestepping that ambiguity —
    // used here as the source of truth on demand (not depending on its
    // own resize/scroll events firing, which is what wasn't reliable
    // about the visualViewport-only approach originally). The Keyboard
    // plugin's events remain as the reliable trigger for *when* to
    // recheck, since visualViewport's own events aren't trustworthy here.
    const measureInset = (fallbackPx) => {
      const vv = window.visualViewport;
      if (vv) return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      return fallbackPx;
    };
    if (platform === 'android') {
      const Keyboard = window.Capacitor.Plugins?.Keyboard;
      if (Keyboard) {
        const recheck = (info) => applyInset(measureInset(info?.keyboardHeight || 0));
        Keyboard.addListener('keyboardWillShow', recheck);
        Keyboard.addListener('keyboardDidShow', recheck);
        Keyboard.addListener('keyboardWillHide', () => applyInset(0));
        Keyboard.addListener('keyboardDidHide', () => applyInset(0));
        applyInset(0);
      }
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => applyInset(measureInset(0));
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }

  async function build() {
    injectStyles();
    setupKeyboardInsetTracking();
    const path = location.pathname;
    const bar = document.createElement('div');
    bar.id = 'chat-app-header';

    const label = document.createElement('a');
    label.className = 'cah-label';
    label.href = '/chat-app/chat.html';
    const logo = document.createElement('img');
    logo.className = 'cah-logo';
    logo.width = 150;
    logo.height = 45;
    logo.loading = 'eager';
    logo.decoding = 'sync';
    logo.alt = 'Pacific Rim Athletics';
    // If the image request ever fails or lags (seen intermittently in the
    // iOS WKWebView runtime), fall back to a text mark instead of leaving
    // the header's logo slot visibly empty with no indication why.
    logo.onerror = () => {
      logo.replaceWith(Object.assign(document.createElement('span'), {
        className: 'cah-logo cah-logo-fallback',
        textContent: 'PRA',
      }));
    };
    logo.src = '/chat-app/assets/pra-logo.png';
    label.appendChild(logo);
    bar.appendChild(label);

    const icons = document.createElement('div');
    icons.className = 'cah-icons';
    bar.appendChild(icons);

    let isAdmin = false, myId = null, myRole = null;
    try {
      const r = await fetch('/api/auth/me');
      if (r.ok) { const d = await r.json(); myRole = d.user?.role || null; isAdmin = myRole === 'admin'; myId = d.user?.id || null; }
    } catch {}

    ICONS.forEach(item => {
      if (item.adminOnly && !isAdmin) return;
      // Always their own protocol, not a fixed page — skip until we know
      // who's logged in (shouldn't happen in practice, this bar only ever
      // renders on already-authenticated pages).
      if (item.selfProtocol && !myId) return;
      const href = item.selfProtocol ? `/chat-app/training-protocol.html?userId=${myId}` : item.href;
      const isActive = item.selfProtocol
        ? (path === '/chat-app/training-protocol.html' && location.search === `?userId=${myId}`)
        : path === href;
      const a = document.createElement('a');
      a.className = 'cah-icon' + (isActive ? ' active' : '');
      a.href = href;
      a.title = item.title;
      a.innerHTML = item.icon;
      icons.appendChild(a);
    });

    const root = document.querySelector('.pra-root') || document.body;

    // .pra-root already declares container-type/container-name (see
    // pra-design-system.css) so @container pra-app queries elsewhere (the
    // mobile header/bottom-bar stacking below, chat.html's sidebar
    // breakpoint) have something to attach to — but personality-quiz/*
    // pages fall back to document.body, which never gets that stylesheet's
    // .pra-root rule at all, so those @container queries had nothing to
    // query and silently never matched no matter how narrow the (real or
    // simulated) width got. Setting it here directly on whichever element
    // `root` actually resolved to make it work for either case — redundant
    // but harmless on .pra-root pages (same values already apply via CSS).
    root.style.containerType = 'inline-size';
    root.style.containerName = 'pra-app';

    // Admin-only device-preview strip — a real strip ABOVE the app (not an
    // icon buried in it), pinning `root` to a fixed device size/orientation
    // so layout can be checked at each breakpoint without a real phone/
    // tablet or opening devtools. "Desktop" just clears every simulated
    // class back to normal responsive behavior. Works whether `root` is
    // .pra-root or the document.body fallback (personality-quiz/* pages
    // don't use .pra-root — see the comment at the top of this file) since
    // the CSS below targets the bare .pra-device-* classes, not
    // .pra-root.pra-device-*; this used to require .pra-root specifically,
    // which silently no-opped the whole preview strip on personality-quiz
    // pages, dropping straight to real full-width with no way to tell.
    // Reassigned once the real reflow() exists further down — applyMode can
    // be invoked (via click) long after setup, by which point this points
    // at the real function; the one call to it during initial setup below,
    // before reflow() exists yet, harmlessly no-ops since setup calls
    // reflow() explicitly right after anyway.
    let requestReflow = () => {};
    let fitDeviceFrame = () => {};
    let deviceStrip = null;

    // Both bars are `position: fixed` (see injectStyles) — `sticky` only
    // stays visible if the page happens to be taller than the viewport at
    // the point it would stick, which silently failed on short pages
    // (Levels with few results, a blank iframe page, etc). Fixed always
    // works, but then needs a spacer left in normal flow so it doesn't
    // cover real content — spacer heights are kept in sync below.
    const headerSpacer = document.createElement('div');
    headerSpacer.id = 'chat-app-header-spacer';
    root.insertBefore(headerSpacer, root.firstChild);
    root.insertBefore(bar, headerSpacer.nextSibling);

    // nav.js's ad-strip bar is ALSO fixed at top:0 — offsetting this bar's
    // own `top` by the ad strip's actual rendered height keeps them
    // stacked instead of overlapping, regardless of how tall that strip
    // currently is (1 row vs 2, collapsed vs not). The device-preview strip
    // (admin-only) adds a further offset — but only when .pra-root is still
    // positioned relative to the real viewport. Once device-frame mode
    // applies its own `position: fixed` to .pra-root, that establishes a
    // NEW containing block for this bar (also `position: fixed`, and a
    // .pra-root descendant), so its `top` needs to stop double-counting the
    // strip height at that point — .pra-root already carries that offset
    // itself via its own CSS `top: var(--pra-device-strip-h)`.
    function reflow() {
      fitDeviceFrame();
      const stripEl = document.getElementById('pra-device-strip');
      const stripHeight = stripEl ? stripEl.getBoundingClientRect().height : 0;
      const navWrap = document.getElementById('pra-nav-wrap');
      const navHeight = navWrap ? navWrap.getBoundingClientRect().height : 0;
      if (navWrap) navWrap.style.top = stripHeight + 'px';
      const inDeviceFrame = root.classList.contains('pra-device-frame');
      // Sets root's `top` directly instead of relying solely on the CSS
      // custom property (--pra-device-strip-h, set by a ResizeObserver on
      // the strip) — that mechanism depends on the observer's callback
      // having already fired by the time this runs, which isn't guaranteed
      // synchronous with the rest of this function, and measured empty on
      // personality-quiz pages (heavier async init possibly delaying it)
      // even after the frame itself had already rendered. This is a direct,
      // synchronous alternative that can't race.
      // Cleared (not just conditionally set) on the else branch — leaving
      // it from a previous device-frame pass meant .pra-root stayed offset
      // by the strip's height even back in normal/desktop mode, where
      // nothing accounts for that offset (.pra-root's own min-height:100vh
      // has no idea it's already been pushed down), permanently forcing a
      // page scroll equal to the strip's height for the rest of the
      // session.
      root.style.top = inDeviceFrame ? stripHeight + 'px' : '';
      const barOffset = inDeviceFrame ? navHeight : stripHeight + navHeight;
      bar.style.top = barOffset + 'px';
      // Spacer reserves space in .pra-root's own NORMAL document flow so
      // real content starts right where the fixed bar visually ends — it
      // has to match bar.style.top exactly (same conditional), or content
      // starts too high and gets tucked underneath the strip+header.
      headerSpacer.style.height = (barOffset + bar.getBoundingClientRect().height) + 'px';
      if (bottomBar) bottomBarSpacer.style.height = bottomBar.getBoundingClientRect().height + 'px';
    }
    requestReflow = reflow;

    let bottomBar = null, bottomBarSpacer = null;
    bottomBar = document.createElement('div');
    bottomBar.id = 'chat-app-bottom-bar';
    const bottomLeftGroup = document.createElement('div');
    bottomLeftGroup.className = 'cah-bottom-group';
    const bottomRightGroup = document.createElement('div');
    bottomRightGroup.className = 'cah-bottom-group';
    BOTTOM_ICONS.forEach(item => {
      // Apply for Training is only relevant to a plain "user" who hasn't
      // signed up for anything yet — hidden for students (already enrolled),
      // coaches, and admins.
      if (item.plainUserOnly && myRole !== 'user') return;
      // Skill levels are internal — coaches/admins only, same gate as the
      // /api/chat/levels* endpoints and levels.html itself.
      if (item.staffOnly && !['coach', 'admin', 'admin2'].includes(myRole)) return;
      // Temporary, while Body Scan is still being built out -- remove this
      // gate (and the devOnly flag on its BOTTOM_ICONS entry above) once
      // it's ready for everyone.
      if (item.devOnly && myId !== DEV_ONLY_USER_ID) return;
      const a = document.createElement('a');
      a.className = 'cah-bottom-item' + (item.label ? ' cah-bottom-label' : '') + (!item.external && path === item.href ? ' active' : '');
      a.href = item.href;
      a.title = item.title;
      if (item.external) { a.target = '_blank'; a.rel = 'noopener'; }
      if (item.label) {
        a.textContent = item.label;
        bottomRightGroup.appendChild(a);
      } else {
        const iconWrap = document.createElement('span');
        iconWrap.innerHTML = item.icon;
        a.appendChild(iconWrap.firstElementChild);
        bottomLeftGroup.appendChild(a);
      }
    });
    if (bottomLeftGroup.children.length) bottomBar.appendChild(bottomLeftGroup);
    if (bottomRightGroup.children.length) bottomBar.appendChild(bottomRightGroup);
    bottomBarSpacer = document.createElement('div');
    bottomBarSpacer.id = 'chat-app-bottom-bar-spacer';
    root.appendChild(bottomBarSpacer);
    root.appendChild(bottomBar);

    // Device-frame mode needs the page's real content to scroll separately
    // from the fixed bars (see the .pra-device-frame CSS comment for why) —
    // move everything that isn't itself `position: fixed` (the bars, the
    // .pra-bg glow, nav.js's own fixed tab strip if present) and isn't one
    // of the two spacers into a dedicated wrapper that does the scrolling
    // instead. Scoped to admin/device-strip only — regular users never hit
    // this path, so their DOM is untouched.
    if (isAdmin && deviceStrip) {
      const contentWrap = document.createElement('div');
      contentWrap.id = 'pra-device-content-wrap';
      const toMove = [...root.children].filter(n =>
        n !== headerSpacer && n !== bottomBarSpacer && getComputedStyle(n).position !== 'fixed'
      );
      toMove.forEach(n => contentWrap.appendChild(n));
      root.insertBefore(contentWrap, bottomBarSpacer);
    }

    reflow();
    setTimeout(reflow, 300); // nav.js finishes its own async render slightly after DOMContentLoaded
    window.addEventListener('resize', reflow);
    const navWrapEl = document.getElementById('pra-nav-wrap');
    if (navWrapEl) new MutationObserver(reflow).observe(navWrapEl, { childList: true, attributes: true });
    new ResizeObserver(reflow).observe(bar);
    new ResizeObserver(reflow).observe(bottomBar);
  }

  document.addEventListener('DOMContentLoaded', build);
})();
