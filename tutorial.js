// Gamified app tutorial (floating step panels, coins, athlete silhouettes,
// fireworks finale). Loaded by chat-header.js -- for now only for the
// tester ids listed there. Progress lives in localStorage so it survives
// page changes; "Play again" / ?tutorial=1 restarts it from step 1.
(function () {
  if (window.PRATutorial) return;
  const KEY = 'praTutorial.v1';
  const me = window.PRA_ME || {};
  const path = location.pathname;

  // ── Steps ─────────────────────────────────────────────────────────────
  // Each step is worth 10 coins (10 steps = 100). A step is a list of subs;
  // each sub lives on one page and points at one thing. page '*' = any page
  // (the top/bottom bars are everywhere). go = where "Next"/"Take me there"
  // goes when this sub's page isn't the current one.
  const PROTOCOL_URL = '/chat-app/training-protocol.html?userId=' + encodeURIComponent(me.id || '');
  const top = (title) => `#chat-app-header a.cah-icon[title="${title}"]`;
  const bottom = (title) => `#chat-app-bottom-bar a.cah-bottom-item[title="${title}"]`;
  const hub = (id) => `.hub-tab[data-hub="${id}"]`;
  const PAGES = {
    chat: { test: p => p === '/chat-app/chat.html' || p === '/chat-app/' , url: '/chat-app/chat.html' },
    protocol: { test: p => p === '/chat-app/training-protocol.html', url: PROTOCOL_URL },
    physique: { test: p => p === '/chat-app/body-scan.html', url: '/chat-app/body-scan.html' },
    map: { test: p => p === '/chat-app/users-map.html', url: '/chat-app/users-map.html' },
    quiz: { test: p => p.startsWith('/personality-quiz/'), url: '/personality-quiz/index.html' },
    levels: { test: p => p === '/chat-app/levels.html', url: '/chat-app/levels.html' },
    shop: { test: p => p === '/chat-app/shop.html', url: '/chat-app/shop.html' },
    retreats: { test: p => p === '/chat-app/retreats.html', url: '/chat-app/retreats.html' },
    profile: { test: p => p === '/chat-app/profile.html', url: '/chat-app/profile.html' },
  };
  const iconSub = (title, sel, text, page) => ({ page: '*', targets: [sel], title, text, go: page, clickGo: true });
  const STEPS = [
    { figure: 'handstand', subs: [
      { page: 'chat', targets: ['.convo-item[data-own-group]', '.convo-item'], title: 'Your private chat group', text: 'Your direct line to your coaches. Ask anything, send videos, get feedback.' },
    ] },
    { figure: 'flare', subs: [
      iconSub('Your Training Protocol', top('My Training Protocol'), 'Your training plan lives here. Tap it or hit Next.', 'protocol'),
      { page: 'protocol', targets: ['#pageViewBtn', '#ownPageBtn', '#programViewBtn', '#lowTicketBtn', '#flowViewBtn', '#viewModeToggle'], activate: true, title: 'Your Training', text: 'Your custom protocol (or the Handstand Protocol), day by day.' },
      { page: 'protocol', targets: ['#katasViewBtn'], activate: true, title: 'Katas', text: 'Flow routines to learn, film and level up.' },
    ] },
    { figure: 'flip', subs: [
      iconSub('Physique Builder', bottom('Powerbatics Body Mastery Builder'), 'Fuel, health, physique and progress in one place.', 'physique'),
      { page: 'physique', targets: [hub('nutrition')], activate: true, title: 'Fuel', text: 'Log your meals and hit your targets.' },
      { page: 'physique', targets: [hub('health')], activate: true, title: 'Health', text: 'Connect your devices for steps, sleep and heart rate.' },
      { page: 'physique', targets: [hub('physique')], activate: true, title: 'Physique', text: 'Progress photos and body scans.' },
      { page: 'physique', targets: [hub('moves')], activate: true, title: 'Moves', text: 'Post your skill clips and collect hearts.' },
      { page: 'physique', targets: [hub('reports')], activate: true, title: 'Reports', text: 'Your progress, week by week.' },
      { page: 'physique', targets: [hub('profile')], activate: true, title: 'Profile', text: 'Your stats and goals.' },
    ] },
    { figure: 'humanflag', subs: [
      iconSub('Strength Ninjas', bottom('Strength Ninjas'), 'The map of everyone training with us.', 'map'),
      { page: 'map', targets: [], title: 'Strength Ninjas map', text: 'See who is training near you and around the world.' },
    ] },
    { figure: 'aerialhoop', subs: [
      iconSub('Training Personality', bottom('Training Personality Quiz'), 'Find out how you train best.', 'quiz'),
      { page: 'quiz', targets: [], title: 'Training Personality', text: 'A quick quiz that shapes how we coach you.' },
    ] },
    { figure: 'handstand', subs: [
      iconSub('Levels', bottom('Levels'), 'Your skill progress, every category.', 'levels'),
      { page: 'levels', targets: [], title: 'Levels', text: 'Level up each skill from 1 to 10 and grow your Super Level.' },
    ] },
    { figure: 'flare', subs: [
      iconSub('Clothing', bottom('Shop'), 'PRA gear.', 'shop'),
      { page: 'shop', targets: [], title: 'Clothing', text: 'Train in the gear. New drops land here first.' },
    ] },
    { figure: 'flip', subs: [
      iconSub('Retreats', bottom('Retreats'), 'Train with us in person.', 'retreats'),
      { page: 'retreats', targets: [], title: 'Retreats', text: 'Coaching trips with the crew. Come train with us.' },
    ] },
    { figure: 'humanflag', subs: [
      iconSub('Your profile', top('My profile'), 'Your account and photo.', 'profile'),
      { page: 'profile', targets: ['.avatar-wrap', '.avatar-lg', '#profileCard'], title: 'Profile pic', text: 'Add a photo so your coaches and the crew know you.' },
    ] },
    { figure: 'aerialhoop', subs: [
      iconSub('Back to chat', top('Chat'), 'Head back to your chat.', 'chat'),
      { page: 'chat', targets: ['.convo-item[data-self-row] .pra-avatar', '.convo-item[data-own-group] .pra-avatar', '.convo-item .pra-avatar'], clickAdvance: true, title: 'Tap your photo', text: 'It opens your profile panel. Tap it or hit Next.' },
      { page: 'chat', targets: ['.pp-backdrop.show .pp-box', '.pp-backdrop.show'], wait: 4000, closePanel: true, title: 'Your profile panel', text: 'Levels, badges and more. Hit Next to head back to chat.' },
    ] },
  ];
  const TOTAL = STEPS.length * 10;

  // ── State ─────────────────────────────────────────────────────────────
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const save = (st) => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  let state = load();
  const fresh = () => ({ active: true, step: 0, sub: 0, coins: 0, done: false });

  // ── Styles ────────────────────────────────────────────────────────────
  const css = `
  .ptu-panel { position: fixed; z-index: 9600; width: min(330px, calc(100vw - 24px)); background: rgba(14,14,19,.97); border: 1px solid rgba(0,155,255,.45);
    border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.6), 0 0 22px rgba(0,155,255,.18); color: #fff; font-family: var(--font-primary, sans-serif);
    overflow: hidden; transition: top .25s, left .25s, opacity .2s; }
  .ptu-prog { height: 5px; background: rgba(255,255,255,.08); }
  .ptu-prog i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #009bff, #ffd23f); box-shadow: 0 0 8px rgba(255,210,63,.7); transition: width .6s cubic-bezier(.2,.8,.2,1); }
  .ptu-body { padding: 12px 14px 14px; position: relative; }
  .ptu-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: .66rem; letter-spacing: .12em; color: #9aa3ad; font-weight: 700; padding-right: 22px; }
  .ptu-tally { display: flex; align-items: center; gap: 6px; color: #ffd23f; font-size: .8rem; letter-spacing: 0; }
  .ptu-coin { width: 14px; height: 14px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff6c2 0 18%, #ffd23f 38%, #d49b00 100%); box-shadow: inset 0 0 0 1.5px #b07f00; display: inline-block; flex-shrink: 0; }
  .ptu-title { font-weight: 800; font-size: 1.02rem; margin: 8px 0 4px; }
  .ptu-text { font-size: .84rem; color: #c3cad3; line-height: 1.45; }
  .ptu-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .ptu-btn { border: none; border-radius: 9px; padding: 9px 18px; font-weight: 800; font-size: .82rem; cursor: pointer; font-family: inherit; background: #009bff; color: #fff; }
  .ptu-btn:hover { background: #0086e0; box-shadow: 0 0 12px rgba(0,155,255,.6); }
  .ptu-btn.ghost { background: rgba(255,255,255,.07); color: #c3cad3; }
  .ptu-btn:disabled { opacity: .5; cursor: default; }
  .ptu-x { position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; border: none; background: none; color: #6b7480; cursor: pointer; padding: 0; font-size: 15px; line-height: 20px; }
  .ptu-x:hover { color: #fff; }
  .ptu-confirm { position: absolute; inset: 0; background: rgba(14,14,19,.98); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 14px; }
  .ptu-confirm .q { font-weight: 800; font-size: 1rem; }
  .ptu-confirm .r { display: flex; gap: 8px; }
  .ptu-ring { position: fixed; z-index: 9599; pointer-events: none; border: 2px solid #009bff; border-radius: 12px; box-shadow: 0 0 0 4px rgba(0,155,255,.18), 0 0 18px rgba(0,155,255,.7);
    animation: ptuPulse 1.2s ease-in-out infinite; transition: top .25s, left .25s, width .25s, height .25s; }
  @keyframes ptuPulse { 50% { box-shadow: 0 0 0 9px rgba(0,155,255,.06), 0 0 28px rgba(0,155,255,.95); } }
  .ptu-arrow { position: fixed; z-index: 9601; width: 34px; height: 46px; pointer-events: none; transition: top .25s, left .25s; }
  .ptu-arrow svg { width: 100%; height: 100%; filter: drop-shadow(0 0 6px rgba(0,155,255,.9)); }
  .ptu-arrow.up svg { animation: ptuBounceUp .8s ease-in-out infinite; }
  .ptu-arrow.down svg { transform: rotate(180deg); animation: ptuBounceDown .8s ease-in-out infinite; }
  @keyframes ptuBounceUp { 50% { transform: translateY(-9px); } }
  @keyframes ptuBounceDown { 0%, 100% { transform: rotate(180deg) translateY(0); } 50% { transform: rotate(180deg) translateY(-9px); } }
  .ptu-fx { position: fixed; inset: 0; z-index: 9602; pointer-events: none; overflow: hidden; }
  .ptu-flycoin { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #fff6c2 0 18%, #ffd23f 38%, #d49b00 100%); box-shadow: inset 0 0 0 2px #b07f00, 0 0 8px rgba(255,210,63,.6); }
  .ptu-flycoin.spin { animation: ptuSpin .35s linear infinite; }
  @keyframes ptuSpin { 50% { transform: scaleX(.15); } }
  .ptu-plus { position: absolute; font-weight: 900; font-size: 1.4rem; color: #ffd23f; text-shadow: 0 0 10px rgba(255,210,63,.8), 0 2px 0 #7a5600; animation: ptuPlus 1.3s ease-out forwards; transform: translate(-50%, 0); }
  @keyframes ptuPlus { 0% { opacity: 0; transform: translate(-50%, 10px) scale(.6); } 20% { opacity: 1; transform: translate(-50%, -10px) scale(1.15); } 100% { opacity: 0; transform: translate(-50%, -60px) scale(1); } }
  .ptu-fig { position: absolute; width: 120px; height: 120px; margin: -60px 0 0 -60px; animation: ptuFigIn 1.6s ease-out forwards; }
  .ptu-fig svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 0 6px rgba(0,155,255,.9)) drop-shadow(0 0 2px #fff); }
  @keyframes ptuFigIn { 0% { opacity: 0; transform: scale(.4) translateY(20px); } 15% { opacity: 1; transform: scale(1.05) translateY(0); } 80% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(.95) translateY(-10px); } }
  .ptu-fig .sway { transform-box: view-box; transform-origin: 60px 112px; animation: ptuSway .9s ease-in-out infinite; }
  @keyframes ptuSway { 0%, 100% { transform: rotate(-5deg); } 50% { transform: rotate(5deg); } }
  .ptu-fig .flare { transform-box: view-box; transform-origin: 60px 60px; animation: ptuFlare .7s linear infinite; }
  @keyframes ptuFlare { 0% { transform: scaleX(1); } 25% { transform: scaleX(.1); } 50% { transform: scaleX(-1); } 75% { transform: scaleX(-.1); } 100% { transform: scaleX(1); } }
  .ptu-fig .flip { transform-box: view-box; transform-origin: 60px 62px; animation: ptuFlip 1.1s cubic-bezier(.45,0,.55,1) infinite; }
  @keyframes ptuFlip { 0% { transform: translateY(18px) rotate(0); } 50% { transform: translateY(-22px) rotate(-180deg); } 100% { transform: translateY(18px) rotate(-360deg); } }
  .ptu-fig .flag { transform-box: view-box; transform-origin: 26px 55px; animation: ptuFlag 1.2s ease-in-out infinite; }
  @keyframes ptuFlag { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(4deg); } }
  .ptu-fig .hoop { transform-box: view-box; transform-origin: 60px 0; animation: ptuHoop 1.4s ease-in-out infinite; }
  @keyframes ptuHoop { 0%, 100% { transform: rotate(-12deg); } 50% { transform: rotate(12deg); } }
  .ptu-fig .hoopspin { transform-box: view-box; transform-origin: 60px 62px; animation: ptuFlare 1.8s linear infinite; }
  .ptu-final { position: fixed; inset: 0; z-index: 9700; display: flex; align-items: center; justify-content: center; background: rgba(4,4,8,.72); }
  .ptu-final canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .ptu-final .box { position: relative; text-align: center; color: #fff; font-family: var(--font-primary, sans-serif); padding: 20px; }
  .ptu-final .score { font-size: 3.4rem; font-weight: 900; color: #ffd23f; text-shadow: 0 0 22px rgba(255,210,63,.8), 0 3px 0 #7a5600; letter-spacing: .02em; animation: ptuScore 1s cubic-bezier(.2,1.6,.4,1) both; }
  @keyframes ptuScore { from { transform: scale(.2); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  .ptu-final .msg { font-size: 1.1rem; font-weight: 800; margin: 6px 0 4px; }
  .ptu-final .sub { color: #9aa3ad; font-size: .86rem; margin-bottom: 16px; }
  .ptu-final .stage { position: relative; width: 170px; height: 170px; margin: 0 auto 10px; }
  .ptu-final .stage .ptu-fig { left: 50%; top: 50%; width: 170px; height: 170px; margin: -85px 0 0 -85px; animation: ptuStage .75s ease-out both; }
  @keyframes ptuStage { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }
  .ptu-final .r { display: flex; gap: 10px; justify-content: center; }
  .ptu-launch { position: fixed; z-index: 2990; right: 14px; bottom: 86px; display: flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(255,210,63,.6);
    background: rgba(14,14,19,.92); color: #ffd23f; font-weight: 800; font-size: .76rem; cursor: pointer; font-family: var(--font-primary, sans-serif); box-shadow: 0 0 14px rgba(255,210,63,.25); }
  .ptu-launch:hover { box-shadow: 0 0 18px rgba(255,210,63,.55); }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── Athlete silhouettes (white line figures, blue glow) ───────────────
  const LINE = 'stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"';
  const FIGS = {
    // Straight handstand balancing on the hands, swaying a little.
    handstand: `<svg viewBox="0 0 120 120"><g class="sway"><path ${LINE} d="M48 112 L54 80 M72 112 L66 80 M54 80 L66 80 M60 80 L60 44 M60 44 L52 10 M60 44 L68 10"/><circle cx="60" cy="92" r="8" fill="#fff"/></g></svg>`,
    // Flare: hands down, hips up, legs straddled -- circles round (scaleX).
    flare: `<svg viewBox="0 0 120 120"><line x1="10" y1="114" x2="110" y2="114" stroke="rgba(0,155,255,.5)" stroke-width="2"/><g class="flare"><path ${LINE} d="M52 112 L56 80 M68 112 L64 80 M56 80 L64 80 M60 80 L84 60 M84 60 L112 42 M84 60 L110 84"/><circle cx="46" cy="76" r="8" fill="#fff"/></g></svg>`,
    // Tucked back flip: jumps and rotates a full turn.
    flip: `<svg viewBox="0 0 120 120"><g class="flip"><circle cx="60" cy="36" r="8" fill="#fff"/><path ${LINE} d="M60 46 L60 70 M60 52 L76 62 L72 76 M60 70 L76 72 L66 86 M60 70 L72 66"/></g></svg>`,
    // Human flag: body horizontal off a vertical pole.
    humanflag: `<svg viewBox="0 0 120 120"><line x1="22" y1="4" x2="22" y2="118" stroke="rgba(255,255,255,.7)" stroke-width="5" stroke-linecap="round"/><g class="flag"><path ${LINE} d="M22 30 L40 46 M22 78 L40 58 M40 46 L40 58 M40 52 L82 52 M82 52 L112 46 M82 52 L112 60"/><circle cx="34" cy="36" r="7.5" fill="#fff"/></g></svg>`,
    // Aerial hoop: athlete hanging in a hoop that swings on its rope.
    aerialhoop: `<svg viewBox="0 0 120 120"><g class="hoop"><line x1="60" y1="0" x2="60" y2="28" stroke="rgba(255,255,255,.7)" stroke-width="3"/><g class="hoopspin"><circle cx="60" cy="62" r="34" stroke="#009bff" stroke-width="5" fill="none"/><path ${LINE} d="M60 28 L48 44 M60 28 L72 44 M48 44 L72 44 M60 44 L62 70 M62 70 L44 88 M62 70 L86 84"/><circle cx="60" cy="54" r="0"/><circle cx="60" cy="36" r="0"/></g><circle cx="60" cy="52" r="0"/></g></svg>`,
  };
  // The hoop athlete's head (drawn after the frame so it sits on top).
  FIGS.aerialhoop = FIGS.aerialhoop.replace('<circle cx="60" cy="54" r="0"/>', '<circle cx="47" cy="52" r="7.5" fill="#fff"/>');

  // ── Sound (Web Audio, all synthesized -- no audio files) ──────────────
  let actx = null;
  function ac() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {}
    return actx;
  }
  function tone(freq, start, dur, type = 'square', vol = 0.12) {
    const c = ac(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, c.currentTime + start);
    g.gain.setValueAtTime(0.0001, c.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol, c.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g).connect(c.destination); o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.02);
  }
  // A handful of coins clinking: bright metallic pings in quick succession.
  function coinSound() {
    const pings = [[2093, 0], [2637, .05], [3136, .1], [2349, .17], [3520, .22], [2794, .3]];
    pings.forEach(([f, t]) => { tone(f, t, 0.22, 'triangle', 0.09); tone(f * 2.01, t, 0.08, 'sine', 0.03); });
  }
  // Original 8-bit victory tune (~3.4s): square lead + triangle bass.
  function victoryTune() {
    const N = { C3: 130.81, F2: 87.31, G2: 98, A2: 110, C4: 261.63, E4: 329.63, G4: 392, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5 };
    const e = 0.15; // eighth note
    const lead = [['G4', 1], ['C5', 1], ['E5', 1], ['G5', 2], ['E5', 1], ['G5', 3],
      ['A5', 1], ['G5', 1], ['E5', 1], ['F5', 1], ['D5', 1], ['G5', 3],
      ['E5', 1], ['G5', 1], ['B5', 1], ['C6', 5]];
    let t = 0;
    lead.forEach(([n, len]) => { tone(N[n], t, e * len * 0.95, 'square', 0.07); t += e * len; });
    const bass = [['C3', 4], ['A2', 4], ['F2', 4], ['G2', 4], ['C3', 6]];
    t = 0;
    bass.forEach(([n, len]) => { tone(N[n], t, e * len * 0.9, 'triangle', 0.16); t += e * len; });
    [0, 0.6, 1.2, 1.8, 2.4].forEach(x => tone(60, x, 0.08, 'sine', 0.25)); // kick
  }

  // ── Effects ───────────────────────────────────────────────────────────
  function fxLayer() { const d = document.createElement('div'); d.className = 'ptu-fx'; document.body.appendChild(d); return d; }
  function coinBurst(x, y, n = 26, layer) {
    const fx = layer || fxLayer();
    const coins = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div'); el.className = 'ptu-flycoin spin';
      el.style.animationDelay = (Math.random() * -0.35) + 's';
      fx.appendChild(el);
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.25;
      const v = 5 + Math.random() * 7;
      coins.push({ el, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, s: 0.7 + Math.random() * 0.6 });
    }
    const t0 = performance.now();
    (function frame(now) {
      const t = (now - t0) / 1000;
      coins.forEach(c => { c.vy += 0.38; c.x += c.vx; c.y += c.vy; c.el.style.left = c.x + 'px'; c.el.style.top = c.y + 'px'; c.el.style.opacity = Math.max(0, 1 - Math.max(0, t - 0.7) / 0.6); c.el.style.width = c.el.style.height = (18 * c.s) + 'px'; });
      if (t < 1.4) requestAnimationFrame(frame); else if (!layer) fx.remove(); else coins.forEach(c => c.el.remove());
    })(t0);
    return fx;
  }
  function stepReward(stepIdx, anchor) {
    const r = anchor.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + 6;
    coinSound();
    const fx = coinBurst(x, y);
    const fig = document.createElement('div'); fig.className = 'ptu-fig';
    fig.style.left = x + 'px'; fig.style.top = Math.max(70, y - 70) + 'px';
    fig.innerHTML = FIGS[STEPS[stepIdx].figure];
    fx.appendChild(fig);
    const plus = document.createElement('div'); plus.className = 'ptu-plus'; plus.textContent = '+10';
    plus.style.left = (x + 70) + 'px'; plus.style.top = Math.max(40, y - 30) + 'px';
    fx.appendChild(plus);
    setTimeout(() => fx.remove(), 1700);
  }

  // ── Panel / pointer UI ────────────────────────────────────────────────
  let panel = null, ring = null, arrow = null, posTimer = null, currentTarget = null, busy = false;
  const ARROW_SVG = '<svg viewBox="0 0 34 46"><path d="M17 2 L32 20 L22 20 L22 44 L12 44 L12 20 L2 20 Z" fill="#009bff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
  function teardown() {
    clearInterval(posTimer); posTimer = null;
    [panel, ring, arrow].forEach(el => el && el.remove());
    panel = ring = arrow = null; currentTarget = null;
  }
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  function findTarget(sub) {
    for (const sel of sub.targets || []) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return el;
    }
    return null;
  }
  function place() {
    if (!panel) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const t = currentTarget && document.contains(currentTarget) && visible(currentTarget) ? currentTarget.getBoundingClientRect() : null;
    if (!t) {
      panel.style.left = Math.round((vw - pw) / 2) + 'px'; panel.style.top = Math.round((vh - ph) / 2) + 'px';
      ring.style.display = 'none'; arrow.style.display = 'none'; return;
    }
    const pad = 6, gap = 58;
    ring.style.display = ''; arrow.style.display = '';
    ring.style.left = (t.left - pad) + 'px'; ring.style.top = (t.top - pad) + 'px';
    ring.style.width = (t.width + pad * 2) + 'px'; ring.style.height = (t.height + pad * 2) + 'px';
    const cx = t.left + t.width / 2;
    const below = t.bottom + gap + ph + 12 <= vh || t.top < vh / 2;
    let top = below ? t.bottom + pad + gap : t.top - pad - gap - ph;
    top = Math.max(12, Math.min(vh - ph - 12, top));
    const left = Math.max(12, Math.min(vw - pw - 12, cx - pw / 2));
    panel.style.left = left + 'px'; panel.style.top = top + 'px';
    arrow.className = 'ptu-arrow ' + (below ? 'up' : 'down');
    arrow.style.left = (Math.max(left + 14, Math.min(left + pw - 48, cx - 17))) + 'px';
    arrow.style.top = (below ? t.bottom + pad + 6 : t.top - pad - 52) + 'px';
  }
  function cancelConfirm() {
    const body = panel.querySelector('.ptu-body');
    const c = document.createElement('div'); c.className = 'ptu-confirm';
    c.innerHTML = '<div class="q">Really cancel?</div><div class="ptu-text">You can restart the tutorial any time.</div><div class="r"><button class="ptu-btn ghost" data-a="no">Keep going</button><button class="ptu-btn" data-a="yes">Yes, cancel</button></div>';
    body.appendChild(c);
    c.querySelector('[data-a="no"]').onclick = () => c.remove();
    c.querySelector('[data-a="yes"]').onclick = () => { state.active = false; save(state); teardown(); mountLauncher(); };
  }
  function render(sub, opts = {}) {
    teardown();
    const stepNo = state.step + 1;
    panel = document.createElement('div'); panel.className = 'ptu-panel';
    panel.innerHTML = `<div class="ptu-prog"><i></i></div><div class="ptu-body">
      <button class="ptu-x" title="Cancel tutorial" aria-label="Cancel tutorial">&#x2715;</button>
      <div class="ptu-head"><span>STEP ${stepNo} / ${STEPS.length}</span><span class="ptu-tally"><span class="ptu-coin"></span><b>${state.coins}</b><span style="color:#6b7480;font-weight:600">/ ${TOTAL}</span></span></div>
      <div class="ptu-title"></div><div class="ptu-text"></div>
      <div class="ptu-foot"><button class="ptu-btn ptu-next">${opts.away ? 'Take me there' : 'Next'}</button></div></div>`;
    panel.querySelector('.ptu-title').textContent = sub.title;
    panel.querySelector('.ptu-text').textContent = sub.text;
    ring = document.createElement('div'); ring.className = 'ptu-ring';
    arrow = document.createElement('div'); arrow.className = 'ptu-arrow up'; arrow.innerHTML = ARROW_SVG;
    document.body.append(ring, arrow, panel);
    requestAnimationFrame(() => { const bar = panel && panel.querySelector('.ptu-prog i'); if (bar) bar.style.width = (state.coins / TOTAL * 100) + '%'; });
    panel.querySelector('.ptu-x').onclick = cancelConfirm;
    panel.querySelector('.ptu-next').onclick = () => { ac(); opts.away ? goTo(sub.go || sub.page) : next(); };
    currentTarget = opts.away ? null : findTarget(sub);
    if (currentTarget) {
      try { currentTarget.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch {}
      if (sub.activate) { try { currentTarget.click(); } catch {} }
      if (sub.clickGo || sub.clickAdvance) {
        currentTarget.addEventListener('click', () => { ac(); if (!busy) advanceSub(true); }, { once: true, capture: true });
      }
    }
    place();
    posTimer = setInterval(() => {
      if (!currentTarget || !document.contains(currentTarget) || !visible(currentTarget)) {
        const t = opts.away ? null : findTarget(sub);
        if (t !== currentTarget) currentTarget = t;
      }
      place();
    }, 250);
  }
  function goTo(pageKey) {
    const pg = PAGES[pageKey];
    if (pg) location.href = pg.url;
  }
  // Move to the next sub; returns true if a step was just completed.
  function advanceSub(viaTargetClick) {
    const step = STEPS[state.step];
    const sub = step.subs[state.sub];
    if (state.sub + 1 < step.subs.length) {
      state.sub++; save(state);
      const nsub = step.subs[state.sub];
      // A click on a nav icon navigates by itself; Next has to do it for them.
      if (sub.clickGo) { if (!viaTargetClick) goTo(sub.go); else teardown(); return; }
      if (viaTargetClick) { teardown(); setTimeout(show, 450); return; }
      show();
      return;
    }
    completeStep();
  }
  function next() {
    if (busy) return;
    const sub = STEPS[state.step].subs[state.sub];
    if (sub.clickAdvance && currentTarget) { currentTarget.click(); return; } // listener advances
    if (sub.closePanel) { const x = document.querySelector('.pp-backdrop.show .pp-close'); if (x) x.click(); }
    advanceSub(false);
  }
  function completeStep() {
    busy = true;
    const btn = panel && panel.querySelector('.ptu-next'); if (btn) btn.disabled = true;
    state.coins = Math.min(TOTAL, state.coins + 10);
    const tally = panel && panel.querySelector('.ptu-tally b'); if (tally) tally.textContent = state.coins;
    const bar = panel && panel.querySelector('.ptu-prog i'); if (bar) bar.style.width = (state.coins / TOTAL * 100) + '%';
    if (panel) stepReward(state.step, panel);
    const finished = state.step + 1 >= STEPS.length;
    if (finished) { state.done = true; state.active = false; } else { state.step++; state.sub = 0; }
    save(state);
    setTimeout(() => { busy = false; if (finished) { teardown(); finale(); } else show(); }, 1600);
  }

  // ── Finale: 100/100, fireworks, athlete performance, victory tune ─────
  function finale() {
    const wrap = document.createElement('div'); wrap.className = 'ptu-final';
    wrap.innerHTML = `<canvas></canvas><div class="box"><div class="stage"></div><div class="score">${TOTAL} / ${TOTAL}</div>
      <div class="msg">Tutorial complete!</div><div class="sub">You know your way around. Now go train.</div>
      <div class="r"><button class="ptu-btn ghost" data-a="again">Play again</button><button class="ptu-btn" data-a="done">Let's go</button></div></div>`;
    document.body.appendChild(wrap);
    victoryTune();
    const stage = wrap.querySelector('.stage');
    const seq = ['handstand', 'flip', 'flare', 'humanflag', 'aerialhoop'];
    let k = 0;
    const showFig = () => { stage.innerHTML = `<div class="ptu-fig">${FIGS[seq[k % seq.length]]}</div>`; k++; };
    showFig();
    const figTimer = setInterval(() => { if (k >= 4) { clearInterval(figTimer); return; } showFig(); }, 750);
    const cv = wrap.querySelector('canvas'), ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    const parts = [];
    const COLORS = ['#009bff', '#ffd23f', '#ffffff', '#5cc8ff', '#ffb000'];
    const burst = () => {
      const x = innerWidth * (0.15 + Math.random() * 0.7), y = innerHeight * (0.12 + Math.random() * 0.4);
      const col = COLORS[Math.floor(Math.random() * COLORS.length)];
      for (let i = 0; i < 60; i++) { const a = Math.random() * Math.PI * 2, v = 1.5 + Math.random() * 4.5; parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, col }); }
      tone(80 + Math.random() * 40, 0, 0.18, 'sine', 0.18);
    };
    let bursts = 0;
    const burstTimer = setInterval(() => { burst(); if (++bursts >= 9) clearInterval(burstTimer); }, 380);
    burst();
    const r = wrap.querySelector('.box').getBoundingClientRect();
    coinBurst(r.left + r.width / 2, r.top + r.height / 2, 40);
    let running = true;
    (function frame() {
      if (!running) return;
      ctx.fillStyle = 'rgba(4,4,8,0.22)'; ctx.fillRect(0, 0, innerWidth, innerHeight);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; p.vy += 0.05; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.life -= 0.012;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        ctx.globalAlpha = p.life; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    })();
    const close = () => { running = false; clearInterval(burstTimer); clearInterval(figTimer); wrap.remove(); mountLauncher(); };
    wrap.querySelector('[data-a="done"]').onclick = close;
    wrap.querySelector('[data-a="again"]').onclick = () => { close(); start(); };
  }

  // ── Flow control ──────────────────────────────────────────────────────
  function pageMatches(key) { return key === '*' || (PAGES[key] && PAGES[key].test(path)); }
  function show() {
    if (!state || !state.active) return;
    const step = STEPS[state.step];
    if (!step) return;
    let sub = step.subs[state.sub];
    // A nav icon was followed by hand: the next sub is already on this page.
    if (sub.page === '*' && sub.go && pageMatches(sub.go) && step.subs[state.sub + 1] && pageMatches(step.subs[state.sub + 1].page)) {
      state.sub++; save(state); sub = step.subs[state.sub];
    }
    if (!pageMatches(sub.page)) { render(sub, { away: true }); return; }
    // Wait (briefly) for the thing to point at to render.
    const t0 = Date.now(), limit = sub.wait || 6000;
    (function wait() {
      if (!state.active) return;
      if (!sub.targets.length || findTarget(sub) || Date.now() - t0 > limit) { render(sub); return; }
      setTimeout(wait, 200);
    })();
  }
  function start() {
    state = fresh(); save(state);
    const lb = document.querySelector('.ptu-launch'); if (lb) lb.remove();
    if (!PAGES.chat.test(path)) { location.href = PAGES.chat.url; return; }
    show();
  }
  function mountLauncher() {
    if (!PAGES.chat.test(path) || document.querySelector('.ptu-launch')) return;
    const b = document.createElement('button'); b.className = 'ptu-launch';
    b.innerHTML = '<span class="ptu-coin"></span>Tutorial';
    b.onclick = () => { ac(); start(); };
    document.body.appendChild(b);
  }

  window.PRATutorial = { start, reset: () => { try { localStorage.removeItem(KEY); } catch {} } };
  const boot = () => {
    if (new URLSearchParams(location.search).get('tutorial') === '1') { start(); return; }
    if (state && state.active) show(); else mountLauncher();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
