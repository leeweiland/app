// Quick Start: gamified walkthrough (floating step panels, coins, athlete
// silhouettes, fireworks finale). Loaded by chat-header.js when
// /api/chat/quickstart says this person gets it (Admin Panel > Quick Start).
// Progress lives in localStorage so it survives page changes; the Quick
// Start button / ?tutorial=1 restarts it from step 1.
(function () {
  if (window.PRATutorial && !window.PRA_QS_EDITOR) return;
  const KEY = 'praTutorial.v1';
  const me = window.PRA_ME || {};
  const QS = window.PRA_QS || { enabled: true };
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
      { page: 'chat', sidebar: true, targets: ['.convo-item[data-own-group]', '.convo-item'], title: 'Your private chat group', text: 'Your direct line to your coaches. Ask anything, send videos, get feedback.' },
    ] },
    { figure: 'cflip', subs: [
      { page: 'chat', roles: ['gym'], openGroup: 'gym', note: 'Gym students only', targets: ['#scheduleBtn'], title: 'Book your gym sessions', text: 'Tap the calendar to schedule your gym sessions.' },
      { page: 'chat', phoneOnly: true, skipIfMissing: true, clickAdvance: true, note: 'Phones only, when a chat is open', targets: ['#backBtn'], title: 'Back to your chats', text: 'Tap back to return to your chats.' },
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
      { page: 'physique', targets: [hub('profile')], activate: true, title: 'Profile', text: 'Enter your details here for accuracy.' },
    ] },
    { figure: 'humanflag', subs: [
      iconSub('Strength Ninjas', bottom('Strength Ninjas'), 'The map of everyone training with us.', 'map'),
      { page: 'map', targets: [], title: 'Strength Ninjas map', text: 'See who is training near you and around the world.' },
    ] },
    { figure: 'hoop_georgia', subs: [
      iconSub('Training Personality', bottom('Training Personality Quiz'), 'Find out how you train best.', 'quiz'),
      { page: 'quiz', targets: [], title: 'Training Personality', text: 'A quick quiz that shapes how we coach you.' },
    ] },
    { figure: 'airflare', subs: [
      iconSub('Levels', bottom('Levels'), 'Your skill progress, every category.', 'levels'),
      { page: 'levels', targets: [], title: 'Levels', text: 'Level up each skill from 1 to 10 and grow your Super Level.' },
    ] },
    { figure: 'hoop_sierra', subs: [
      iconSub('Clothing', bottom('Shop'), 'PRA gear. Students get 10% off.', 'shop'),
      { page: 'shop', targets: [], title: 'Clothing', text: 'Students get 10% off clothing. Use code STUDENTS at checkout.' },
    ] },
    { figure: 'frontflip', subs: [
      iconSub('Retreats', bottom('Retreats'), 'Train with us in person.', 'retreats'),
      { page: 'retreats', targets: [], title: 'Retreats', text: 'Coaching trips with the crew. Come train with us.' },
    ] },
    { figure: 'hoop_sedona', subs: [
      iconSub('Your profile', top('My profile'), 'Your account and photo.', 'profile'),
      { page: 'profile', targets: ['#profileCard .pp-avatar-wrap', '#profileCard .pp-avatar', '.avatar-wrap'], gap: 40, title: 'Profile pic', text: 'Add a photo so your coaches and the crew know you.' },
    ] },
    { figure: 'press', subs: [
      iconSub('Back to chat', top('Chat'), 'Head back to your chat.', 'chat'),
      { page: 'chat', sidebar: true, targets: ['.convo-item[data-own-group] .pra-avatar', '.convo-item[data-self-row] .pra-avatar', '.convo-item .pra-avatar'], clickAdvance: true, title: 'Tap your photo', text: 'Tap your group photo to open your profile panel.' },
      { page: 'chat', targets: ['.pp-backdrop.show .pp-box', '.pp-backdrop.show'], wait: 4000, closePanel: true, placement: 'bottom', title: 'Your profile panel', text: 'Levels, badges and more. Hit Next to head back to chat.' },
      { page: 'chat', openGroup: 'own', skipIfMissing: true, targets: ['#textInput'], title: 'Message your coaches', text: 'Now send your coaches a message. Say hi and tell them your goals.' },
    ] },
  ];
  // Admin Panel > Quick Start loads this file only to read the default wording.
  if (window.PRA_QS_EDITOR) { window.PRA_QS_STEPS = STEPS; return; }
  Object.entries(QS.texts || {}).forEach(([k, v]) => {
    const [si, ui] = k.split('.').map(n => parseInt(n, 10) - 1);
    const sub = STEPS[si] && STEPS[si].subs[ui];
    if (sub && v) { if (v.title) sub.title = v.title; if (v.text) sub.text = v.text; }
  });
  // Role-only parts (e.g. gym booking) -- testers see every part.
  STEPS.forEach(st => { st.subs = st.subs.filter(sub => !sub.roles || sub.roles.includes(me.role) || QS.tester); });
  const isPhone = () => window.innerWidth < 768;
  const TOTAL = STEPS.length * 10;

  // ── State ─────────────────────────────────────────────────────────────
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const save = (st) => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  let state = load();
  const fresh = () => ({ active: true, step: 0, sub: 0, coins: 0, done: false });

  // ── Styles ────────────────────────────────────────────────────────────
  const css = `
  .ptu-halo { position: fixed; z-index: 9598; pointer-events: none; border-radius: 48px; background: rgba(0,0,0,.55);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    -webkit-mask-image: radial-gradient(closest-side, #000 72%, transparent 100%); mask-image: radial-gradient(closest-side, #000 72%, transparent 100%);
    transition: top .25s, left .25s, width .25s, height .25s; }
  .ptu-panel { position: fixed; z-index: 9600; width: min(330px, calc(100vw - 24px)); background: #fff; border: none;
    border-radius: 14px; box-shadow: 0 0 0 1px rgba(0,0,0,.06), 0 0 50px 18px rgba(0,0,0,.85); color: #0b0b10; font-family: var(--font-primary, sans-serif);
    overflow: hidden; transition: top .25s, left .25s, opacity .2s; }
  .ptu-prog { height: 6px; background: #e9ecf1; }
  .ptu-prog i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #009bff, #ffd23f); box-shadow: 0 0 8px rgba(255,210,63,.7); transition: width .6s cubic-bezier(.2,.8,.2,1); }
  .ptu-body { padding: 12px 14px 14px; position: relative; }
  .ptu-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: .66rem; letter-spacing: .12em; color: #6b7280; font-weight: 700; padding-right: 22px; }
  .ptu-tally { display: flex; align-items: center; gap: 6px; color: #b07f00; font-size: .8rem; letter-spacing: 0; }
  .ptu-coin { width: 14px; height: 14px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff6c2 0 18%, #ffd23f 38%, #d49b00 100%); box-shadow: inset 0 0 0 1.5px #b07f00; display: inline-block; flex-shrink: 0; }
  .ptu-title { font-weight: 800; font-size: 1.02rem; margin: 8px 0 4px; }
  .ptu-text { font-size: .86rem; color: #374151; line-height: 1.45; }
  .ptu-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; }
  .ptu-btn { border: none; border-radius: 9px; padding: 9px 18px; font-weight: 800; font-size: .82rem; cursor: pointer; font-family: inherit; background: #009bff; color: #fff; }
  .ptu-btn:hover { background: #0086e0; box-shadow: 0 0 12px rgba(0,155,255,.6); }
  .ptu-btn.ghost { background: #eef0f3; color: #374151; }
  .ptu-btn.ghost:hover { background: #e2e5ea; box-shadow: none; }
  .ptu-btn.dark { background: #1f2937; color: #fff; }
  .ptu-btn.dark:hover { background: #0b0b10; box-shadow: none; }
  .ptu-back { visibility: hidden; }
  .ptu-back.on { visibility: visible; }
  .ptu-btn:disabled { opacity: .5; cursor: default; }
  .ptu-x { position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; border: none; background: none; color: #9ca3af; cursor: pointer; padding: 0; font-size: 15px; line-height: 20px; }
  .ptu-x:hover { color: #0b0b10; }
  .ptu-confirm { position: absolute; inset: 0; background: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 14px; }
  .ptu-confirm .q { font-weight: 800; font-size: 1rem; }
  .ptu-confirm .r { display: flex; gap: 8px; }
  .ptu-ring { position: fixed; z-index: 9599; pointer-events: none; border: 2px solid #009bff; border-radius: 12px; box-shadow: 0 0 0 4px rgba(0,155,255,.18), 0 0 18px rgba(0,155,255,.7);
    animation: ptuPulse 1.2s ease-in-out infinite; transition: top .25s, left .25s, width .25s, height .25s; }
  @keyframes ptuPulse { 50% { box-shadow: 0 0 0 9px rgba(0,155,255,.06), 0 0 28px rgba(0,155,255,.95); } }
  .ptu-arrow { position: fixed; z-index: 9601; width: 26px; height: 48px; pointer-events: none; transition: top .25s, left .25s; }
  .ptu-arrow svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 0 6px rgb(212,255,0)) drop-shadow(0 0 2px rgb(212,255,0)); }
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
  .ptu-fig { position: absolute; width: 150px; height: 150px; margin: -75px 0 0 -75px; animation: ptuFigIn 1.6s ease-out forwards; }
  .ptu-fig img { width: 100%; height: 100%; object-fit: contain; display: block; filter: drop-shadow(0 0 7px rgba(0,155,255,.95)) drop-shadow(0 0 2px rgba(255,255,255,.9)); }
  @keyframes ptuFigIn { 0% { opacity: 0; transform: scale(.4) translateY(20px); } 15% { opacity: 1; transform: scale(1.05) translateY(0); } 80% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(.95) translateY(-10px); } }
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
  .ptu-launch { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px; border-radius: 15px; border: 2px solid rgb(212,255,0);
    background: #0b0b0f; color: rgb(212,255,0); font-weight: 800; font-size: .74rem; letter-spacing: .03em; cursor: pointer; font-family: var(--font-primary, sans-serif); white-space: nowrap;
    text-shadow: 0 0 8px rgba(212,255,0,.67); flex-shrink: 0; animation: ptuLaunchPulse 1.6s ease-in-out infinite; }
  .ptu-launch:hover { animation-play-state: paused; box-shadow: 0 0 24px rgba(212,255,0,.9), inset 0 0 10px rgba(212,255,0,.3); }
  @keyframes ptuLaunchPulse { 0%, 100% { box-shadow: 0 0 8px rgba(212,255,0,.45), inset 0 0 6px rgba(212,255,0,.15); } 50% { box-shadow: 0 0 22px rgba(212,255,0,.95), inset 0 0 10px rgba(212,255,0,.35); } }
  .ptu-launch.in-bar { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2; }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── Athlete silhouettes (white line figures, blue glow) ───────────────
  // Real moves, one per step: white silhouettes cut from real footage (Lee's
  // handstand, backflip, human flag, airflare, front flip, planche press;
  // Clayton's drop gainer flip; Georgia, Sierra and Sedona on aerial hoop), rendered
  // as transparent animated WebP in /chat-app/assets/quickstart/.
  const FIG_SRC = (n) => `/chat-app/assets/quickstart/${n}.webp?v=3`;
  const FIGS = new Proxy({}, { get: (_, n) => `<img src="${FIG_SRC(String(n))}" alt="">` });
  ['handstand', 'cflip', 'flip', 'humanflag', 'hoop_georgia', 'airflare', 'hoop_sierra', 'frontflip', 'hoop_sedona', 'press'].forEach(n => { const im = new Image(); im.src = FIG_SRC(n); });

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
    // Burst in clear space right above the panel (below it if there's no room),
    // with the step's arrow + ring hidden so nothing overlaps the athlete.
    if (ring) ring.style.visibility = 'hidden';
    if (arrow) arrow.style.visibility = 'hidden';
    const x = r.left + r.width / 2;
    const y = r.top > 190 ? r.top - 88 : r.bottom + 88;
    coinSound();
    const fx = coinBurst(x, y);
    const fig = document.createElement('div'); fig.className = 'ptu-fig';
    fig.style.left = x + 'px'; fig.style.top = y + 'px';
    fig.innerHTML = FIGS[STEPS[stepIdx].figure];
    fx.appendChild(fig);
    const plus = document.createElement('div'); plus.className = 'ptu-plus'; plus.textContent = '+10';
    plus.style.left = (x + 92) + 'px'; plus.style.top = (y - 30) + 'px';
    fx.appendChild(plus);
    setTimeout(() => fx.remove(), 1700);
  }

  // ── Panel / pointer UI ────────────────────────────────────────────────
  let panel = null, ring = null, arrow = null, halo = null, posTimer = null, currentTarget = null, currentSub = null, busy = false;
  const ARROW_SVG = '<svg viewBox="0 0 26 48"><path d="M13 1 L24 15 L2 15 Z" fill="rgb(212,255,0)"/><rect x="11" y="14" width="4" height="33" rx="2" fill="rgb(212,255,0)"/></svg>';
  function teardown() {
    clearInterval(posTimer); posTimer = null;
    [panel, ring, arrow, halo].forEach(el => el && el.remove());
    panel = ring = arrow = halo = null; currentTarget = null; currentSub = null;
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
      ring.style.display = 'none'; arrow.style.display = 'none'; placeHalo(); return;
    }
    const pad = 6, gap = (currentSub && currentSub.gap) || 52;
    // Tall targets (e.g. the profile panel): panel docks at the bottom of the
    // screen with the arrow above it, pointing up into the target.
    if ((currentSub && currentSub.placement === 'bottom') || t.height > vh * 0.55) {
      ring.style.display = ''; arrow.style.display = '';
      ring.style.left = (t.left - pad) + 'px'; ring.style.top = (t.top - pad) + 'px';
      ring.style.width = (t.width + pad * 2) + 'px'; ring.style.height = (t.height + pad * 2) + 'px';
      const ptop = vh - ph - 16, pleft = Math.max(12, Math.min(vw - pw - 12, t.left + t.width / 2 - pw / 2));
      panel.style.left = pleft + 'px'; panel.style.top = ptop + 'px';
      arrow.className = 'ptu-arrow up';
      arrow.style.left = (pleft + pw / 2 - 13) + 'px'; arrow.style.top = (ptop - 56) + 'px';
      placeHalo(); return;
    }
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
    arrow.style.left = (Math.max(left + 14, Math.min(left + pw - 40, cx - 13))) + 'px';
    arrow.style.top = (below ? t.bottom + pad + 4 : t.top - pad - 52) + 'px';
    placeHalo();
  }
  function placeHalo() {
    if (!halo || !panel) return;
    const r = panel.getBoundingClientRect(), e = 44;
    halo.style.left = (r.left - e) + 'px'; halo.style.top = (r.top - e) + 'px';
    halo.style.width = (r.width + e * 2) + 'px'; halo.style.height = (r.height + e * 2) + 'px';
  }
  function cancelConfirm() {
    const body = panel.querySelector('.ptu-body');
    const c = document.createElement('div'); c.className = 'ptu-confirm';
    c.innerHTML = '<div class="q">Really cancel?</div><div class="r"><button class="ptu-btn dark" data-a="yes">Yes, cancel</button><button class="ptu-btn" data-a="no">Keep going</button></div>';
    body.appendChild(c);
    c.querySelector('[data-a="no"]').onclick = () => c.remove();
    c.querySelector('[data-a="yes"]').onclick = () => { state.active = false; state.cancelled = true; save(state); teardown(); mountLauncher(); };
  }
  function render(sub, opts = {}) {
    teardown();
    const stepNo = state.step + 1;
    panel = document.createElement('div'); panel.className = 'ptu-panel';
    panel.innerHTML = `<div class="ptu-prog"><i></i></div><div class="ptu-body">
      <button class="ptu-x" title="Close Quick Start" aria-label="Close Quick Start">&#x2715;</button>
      <div class="ptu-head"><span>STEP ${stepNo} / ${STEPS.length}</span><span class="ptu-tally"><span class="ptu-coin"></span><b>${state.coins}</b><span style="color:#9ca3af;font-weight:600">/ ${TOTAL}</span></span></div>
      <div class="ptu-title"></div><div class="ptu-text"></div>
      <div class="ptu-foot"><button class="ptu-btn ghost ptu-back${(state.step || state.sub) ? ' on' : ''}">Back</button><button class="ptu-btn ptu-next">${opts.away ? 'Take me there' : 'Next'}</button></div></div>`;
    panel.querySelector('.ptu-title').textContent = sub.title;
    panel.querySelector('.ptu-text').textContent = sub.text;
    currentSub = sub;
    halo = document.createElement('div'); halo.className = 'ptu-halo';
    ring = document.createElement('div'); ring.className = 'ptu-ring';
    arrow = document.createElement('div'); arrow.className = 'ptu-arrow up'; arrow.innerHTML = ARROW_SVG;
    document.body.append(halo, ring, arrow, panel);
    requestAnimationFrame(() => { const bar = panel && panel.querySelector('.ptu-prog i'); if (bar) bar.style.width = (state.coins / TOTAL * 100) + '%'; });
    panel.querySelector('.ptu-x').onclick = cancelConfirm;
    panel.querySelector('.ptu-back').onclick = () => { ac(); back(); };
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
      // Chat-list parts: if the app opens a chat on its own (e.g. restoring the
      // last one on a phone), go back to the list so the arrow has its target.
      if (sub.sidebar && !opts.away && isPhone()) {
        const shell = document.querySelector('.chat-shell');
        if (shell && shell.classList.contains('thread-open')) { const bb = document.getElementById('backBtn'); if (bb) bb.click(); }
      }
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
  // Back one sub (or into the previous step, giving its 10 coins back).
  function back() {
    if (busy) return;
    const cur = STEPS[state.step].subs[state.sub];
    if (cur.closePanel) { const x = document.querySelector('.pp-backdrop.show .pp-close'); if (x) x.click(); }
    if (state.sub > 0) state.sub--;
    else if (state.step > 0) { state.step--; state.sub = STEPS[state.step].subs.length - 1; }
    else return;
    state.coins = state.step * 10; state.noSkip = true;
    save(state);
    const sub = STEPS[state.step].subs[state.sub];
    // Backing onto a nav-icon sub: show it on the page before (where the icon was tapped).
    let pageKey = sub.page;
    if (pageKey === '*') {
      const prev = state.sub > 0 ? STEPS[state.step].subs[state.sub - 1] : (state.step > 0 ? STEPS[state.step - 1].subs.slice(-1)[0] : null);
      pageKey = prev && prev.page !== '*' ? prev.page : '*';
    }
    if (pageKey === '*' || pageMatches(pageKey)) show(); else goTo(pageKey);
  }
  function completeStep() {
    busy = true;
    const btn = panel && panel.querySelector('.ptu-next'); if (btn) btn.disabled = true;
    state.coins = Math.min(TOTAL, state.coins + 10);
    const tally = panel && panel.querySelector('.ptu-tally b'); if (tally) tally.textContent = state.coins;
    const bar = panel && panel.querySelector('.ptu-prog i'); if (bar) bar.style.width = (state.coins / TOTAL * 100) + '%';
    if (panel) stepReward(state.step, panel);
    const finished = state.step + 1 >= STEPS.length;
    if (finished) { state.done = true; state.active = false; markComplete(); } else { state.step++; state.sub = 0; }
    save(state);
    setTimeout(() => { busy = false; if (finished) { teardown(); finale(); } else show(); }, 1600);
  }

  // ── Finale: 100/100, fireworks, athlete performance, victory tune ─────
  function finale() {
    const wrap = document.createElement('div'); wrap.className = 'ptu-final';
    wrap.innerHTML = `<canvas></canvas><div class="box"><div class="stage"></div><div class="score">${TOTAL} / ${TOTAL}</div>
      <div class="msg">Quick Start complete!</div><div class="sub">You know your way around. Now go train.</div></div>`;
    document.body.appendChild(wrap);
    victoryTune();
    const stage = wrap.querySelector('.stage');
    const seq = ['frontflip', 'cflip', 'hoop_sedona', 'handstand'];
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
    // After the 3s show, straight back to the chat.
    setTimeout(() => { wrap.style.transition = 'opacity .4s'; wrap.style.opacity = '0'; setTimeout(() => { close(); if (!PAGES.chat.test(path)) location.href = PAGES.chat.url; }, 400); }, 3400);
  }

  function markComplete() {
    QS.completed = true; QS.showButton = true;
    fetch('/api/chat/quickstart/complete', { method: 'POST' }).catch(() => {});
  }

  // ── Flow control ──────────────────────────────────────────────────────
  function pageMatches(key) { return key === '*' || (PAGES[key] && PAGES[key].test(path)); }
  function show() {
    if (!state || !state.active) return;
    const step = STEPS[state.step];
    if (!step) return;
    let sub = step.subs[state.sub];
    // A nav icon was followed by hand: the next sub is already on this page.
    const noSkip = state.noSkip; if (noSkip) { delete state.noSkip; save(state); }
    if (!noSkip && sub.page === '*' && sub.go && pageMatches(sub.go) && step.subs[state.sub + 1] && pageMatches(step.subs[state.sub + 1].page)) {
      state.sub++; save(state); sub = step.subs[state.sub];
    }
    if (!pageMatches(sub.page)) { render(sub, { away: true }); return; }
    // Phone-only parts are skipped on bigger screens.
    if (sub.phoneOnly && !isPhone()) { advanceSub(true); return; }
    // Parts that live in the chat list: on a phone an open chat hides the
    // list, so close it first.
    if (sub.sidebar) {
      const shell = document.querySelector('.chat-shell');
      if (shell && shell.classList.contains('thread-open') && isPhone()) { const bb = document.getElementById('backBtn'); if (bb) bb.click(); }
    }
    // Open the chat the part points into: their own group, else (testers)
    // the first Gym student's group for the calendar, or the first chat.
    if (sub.openGroup && !findTarget(sub)) {
      const rows = [...document.querySelectorAll('.convo-item')];
      const own = document.querySelector('.convo-item[data-own-group]');
      const row = own || (sub.openGroup === 'gym' ? rows.find(r => r.querySelector('.role-tag-gym')) : rows.find(r => !r.hasAttribute('data-self-row')) || rows[0]);
      if (row) row.click();
    }
    // Wait (briefly) for the thing to point at to render. A part that can't
    // find its target is skipped instead of floating with no arrow.
    const skippable = sub.openGroup || sub.skipIfMissing;
    const t0 = Date.now(), limit = sub.wait || (sub.openGroup ? 2500 : sub.skipIfMissing ? 700 : 6000);
    (function wait() {
      if (!state.active) return;
      if (!sub.targets.length || findTarget(sub)) { render(sub); return; }
      if (Date.now() - t0 > limit) { if (skippable) advanceSub(true); else render(sub); return; }
      setTimeout(wait, 120);
    })();
  }
  function start() {
    state = fresh(); save(state);
    if (!PAGES.chat.test(path)) { location.href = PAGES.chat.url; return; }
    show();
  }
  // Shown once they've finished it, inside the day windows set in Admin Panel.
  // Phone: right of "Chats" (right of the students count for staff), which
  // sits centered under the first row of icons. Desktop: centered in the top bar.
  function mountLauncher() {
    if (!QS.showButton) return;
    let b = document.querySelector('.ptu-launch');
    if (!b) {
      b = document.createElement('button'); b.type = 'button'; b.className = 'ptu-launch';
      b.innerHTML = '<span class="ptu-coin"></span>Quick Start';
      b.onclick = () => { ac(); start(); };
    }
    const wide = window.innerWidth >= 768;
    const bar = document.getElementById('chat-app-header');
    const chatsRow = document.getElementById('studentsCountBtn') && document.getElementById('studentsCountBtn').parentElement;
    if (wide && bar) {
      b.classList.add('in-bar');
      if (b.parentElement !== bar) { if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative'; bar.appendChild(b); }
    } else if (chatsRow) {
      b.classList.remove('in-bar');
      if (b.parentElement !== chatsRow) chatsRow.appendChild(b);
    } else if (b.parentElement) b.remove();
  }
  window.addEventListener('resize', () => { if (document.querySelector('.ptu-launch')) mountLauncher(); });

  window.PRATutorial = { start, reset: () => { try { localStorage.removeItem(KEY); } catch {} } };
  const boot = () => {
    if (new URLSearchParams(location.search).get('tutorial') === '1') { start(); return; }
    if (state && state.done && !QS.completed) markComplete();
    if (state && state.active) { show(); return; }
    mountLauncher();
    if (QS.autoStart && !QS.completed && PAGES.chat.test(path) && !(state && (state.cancelled || state.done))) start();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
