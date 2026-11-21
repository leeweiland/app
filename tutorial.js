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
    // The phone app opens at the site root, which serves the chat page.
    chat: { test: p => p === '/chat-app/chat.html' || p === '/chat-app/' || p === '/', url: '/chat-app/chat.html' },
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
  // Figure order (Lee, 2026-11-21): no two flips, two aerial (hoop/silks) or
  // two handstands back to back -- flips at 2/5/8, aerial at 3/6/9, handstands at 1/10.
  const STEPS = [
    { figure: 'handstand', subs: [
      { page: 'chat', sidebar: true, targets: ['.convo-item[data-own-group]', '.convo-item'], kicker: 'Play The Quick Start Game To MASTER The App', kickerNote: '2 min.', title: 'Your private chat group', text: 'Your direct line to your coaches. Ask anything, send videos, get feedback.' },
    ] },
    { figure: 'cflip', subs: [
      { page: 'chat', roles: ['gym'], openGroup: 'gym', note: 'Gym students only', targets: ['#scheduleBtn'], title: 'Book your gym sessions', text: 'Tap the calendar to schedule your gym sessions.' },
      { page: 'chat', phoneOnly: true, skipIfMissing: true, clickAdvance: true, note: 'Phones only, when a chat is open', targets: ['#backBtn'], title: 'Back to your chats', text: 'Tap back to return to your chats.' },
      iconSub('Your Training Protocol', top('My Training Protocol'), 'Your training plan lives here. Tap it or hit Next.', 'protocol'),
      { page: 'protocol', targets: ['#pageViewBtn', '#ownPageBtn', '#programViewBtn', '#lowTicketBtn', '#flowViewBtn', '#viewModeToggle'], activate: true, title: 'Your Training', text: 'Your custom training protocol, day by day.', textByRole: { trainee: 'Your Handstand Protocol, day by day.' } },
      { page: 'protocol', targets: ['#katasViewBtn'], activate: true, title: 'Katas', text: 'Flow routines to learn, film and level up.' },
    ] },
    { figure: 'hoop_georgia', subs: [
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
    { figure: 'flip', subs: [
      iconSub('Training Personality', bottom('Training Personality Quiz'), 'Find out how you train best.', 'quiz'),
      { page: 'quiz', targets: [], title: 'Training Personality', text: 'A quick quiz that shapes how we coach you.' },
    ] },
    { figure: 'silks_alexis', subs: [
      iconSub('Levels', bottom('Levels'), 'Your skill progress, every category.', 'levels'),
      { page: 'levels', targets: [], title: 'Levels', text: 'Level up each skill from 1 to 10 and grow your Super Level.' },
    ] },
    { figure: 'airflare', subs: [
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
  // Wording that depends on who's looking (e.g. Handstand Protocol buyers).
  STEPS.forEach(st => st.subs.forEach(sub => { if (sub.textByRole && sub.textByRole[me.role]) sub.text = sub.textByRole[me.role]; }));
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
  .ptu-kicker { margin-top: 10px; font-size: .94rem; font-weight: 900; color: #0077cc; line-height: 1.25; }
  .ptu-kicker-note { font-weight: 300; color: #111; white-space: nowrap; }
  .ptu-kicker + .ptu-title { margin-top: 3px; }
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
  /* Bigger, clearly-a-coin coins (Lee, 2026-11-21): gold disc, raised rim,
     embossed star, a flip slow enough to read. Size is set per coin in JS. */
  .ptu-flycoin { position: absolute; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 32% 28%, #fff8d0 0 14%, #ffe066 32%, #f5b800 62%, #c98a00 100%);
    box-shadow: inset 0 0 0 2.5px #9a6a00, inset 0 0 0 5px #ffd84a, inset 0 0 0 6.5px #b88000, 0 0 12px rgba(255,210,63,.85), 0 2px 4px rgba(0,0,0,.5); }
  .ptu-flycoin::after { content: "★"; color: #b07a00; font-size: 52%; line-height: 1; text-shadow: 0 1px 0 #fff3b0, 0 -1px 0 #8a5c00; }
  .ptu-flycoin.spin { animation: ptuSpin .6s linear infinite; }
  .ptu-flyemoji { position: absolute; font-size: 44px; line-height: 1; transform: translate(-50%,-50%); filter: drop-shadow(0 0 2px #fff) drop-shadow(0 0 10px rgba(255,210,63,.9)); }
  .ptu-final-stage { position: relative; margin: 0 auto 12px; pointer-events: none; }
  @keyframes ptuSpin { 50% { transform: scaleX(.15); } }
  .ptu-plus { position: absolute; font-weight: 900; font-size: 1.4rem; color: #ffd23f; text-shadow: 0 0 10px rgba(255,210,63,.8), 0 2px 0 #7a5600; animation: ptuPlus 1.3s ease-out forwards; transform: translate(-50%, 0); }
  @keyframes ptuPlus { 0% { opacity: 0; transform: translate(-50%, 10px) scale(.6); } 20% { opacity: 1; transform: translate(-50%, -10px) scale(1.15); } 100% { opacity: 0; transform: translate(-50%, -60px) scale(1); } }
  .ptu-fig { position: absolute; width: 150px; height: 150px; margin: -75px 0 0 -75px; animation: ptuFigIn 2.4s ease-out forwards; }
  .ptu-fig { isolation: isolate; }
  .ptu-fig::before { content: ''; position: absolute; inset: -14%; z-index: -1; border-radius: 50%; background: radial-gradient(circle, rgba(0,0,0,.82) 0%, rgba(0,0,0,.6) 52%, rgba(0,0,0,0) 72%);
    backdrop-filter: blur(9px); -webkit-backdrop-filter: blur(9px); -webkit-mask-image: radial-gradient(circle, #000 55%, transparent 72%); mask-image: radial-gradient(circle, #000 55%, transparent 72%); }
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
  .ptu-launch.in-bar-right { position: absolute; right: 12px; transform: translateY(-50%); z-index: 2; }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── Athlete silhouettes (white line figures, blue glow) ───────────────
  // Real moves, one per step: white silhouettes cut from real footage (Lee's
  // handstand, backflip, human flag, airflare, front flip, planche press;
  // Clayton's drop gainer flip; Georgia and Sedona on aerial hoop; Alexis on silks), rendered
  // as transparent animated WebP in /chat-app/assets/quickstart/.
  const FIG_SRC = (n) => `/chat-app/assets/quickstart/${n}.webp?v=7`;
  // Each showing gets a fresh object URL of the downloaded file, so the clip
  // always plays from its first frame (a reused URL resumes mid-loop).
  const FIG_BLOBS = {};
  ['handstand', 'cflip', 'flip', 'humanflag', 'hoop_georgia', 'airflare', 'silks_alexis', 'frontflip', 'hoop_sedona', 'press'].forEach(n => {
    fetch(FIG_SRC(n)).then(r => r.ok ? r.blob() : null).then(b => { if (b) FIG_BLOBS[n] = b; }).catch(() => {});
  });
  const FIGS = new Proxy({}, { get: (_, n) => {
    const b = FIG_BLOBS[String(n)];
    const src = b ? URL.createObjectURL(b) : FIG_SRC(String(n)) + '&t=' + Date.now();
    return `<img src="${src}" alt="">`;
  } });

  // ── Sound (Web Audio, all synthesized -- no audio files) ──────────────
  // 8-bit console style (Lee, 2026-11-21: "more like Mario Bros 1 or Sonic
  // 1"): NES-like pulse waves with a set duty cycle, triangle bass, a noise
  // channel for drums and fireworks. All melodies are original.
  let actx = null, master = null;
  const pulseWaves = {};
  const NOTE = (n) => { // 'C5', 'F#4', 'Bb3' -> Hz
    const m = /^([A-G])([#b]?)(\d)$/.exec(n); if (!m) return 0;
    const semi = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return 440 * Math.pow(2, (semi - 9) / 12 + (Number(m[3]) - 4));
  };
  function ac() {
    try {
      if (!actx) {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        master = actx.createGain(); master.gain.value = 0.9;
        const comp = actx.createDynamicsCompressor();
        master.connect(comp).connect(actx.destination);
      }
      if (actx.state === 'suspended') actx.resume();
    } catch {}
    return actx;
  }
  // Pulse wave with a given duty (0.125 / 0.25 / 0.5) -- the NES's lead sound.
  function pulse(duty) {
    const c = ac(); if (!c) return null;
    if (pulseWaves[duty]) return pulseWaves[duty];
    const n = 48, re = new Float32Array(n), im = new Float32Array(n);
    for (let k = 1; k < n; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    return (pulseWaves[duty] = c.createPeriodicWave(re, im));
  }
  // One note. type: 'p12' | 'p25' | 'p50' (pulse) or any OscillatorType.
  // opts.slide: end frequency (pitch bend), opts.release: tail after dur.
  function tone(freq, start, dur, type = 'p25', vol = 0.12, opts = {}) {
    const c = ac(); if (!c || !freq) return;
    const t0 = c.currentTime + start, rel = opts.release ?? 0.04, sus = opts.sustain ?? 0.85;
    const o = c.createOscillator(), g = c.createGain();
    if (/^p(12|25|50)$/.test(type)) o.setPeriodicWave(pulse({ p12: 0.125, p25: 0.25, p50: 0.5 }[type]));
    else o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(opts.slide, t0 + dur);
    if (opts.vibrato) { const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = 6; lg.gain.value = freq * 0.012; l.connect(lg).connect(o.frequency); l.start(t0 + dur * 0.4); l.stop(t0 + dur + rel); }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.004);
    g.gain.setValueAtTime(vol * sus, t0 + Math.max(0.005, dur * 0.3));
    g.gain.linearRampToValueAtTime(vol * sus * 0.7, t0 + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + rel);
    o.connect(g).connect(master);
    o.start(t0); o.stop(t0 + dur + rel + 0.02);
  }
  let noiseBuf = null;
  // Noise channel: drums, sparkle, fireworks. lp: low-pass cutoff (Hz), lpEnd: sweep to.
  function noise(start, dur, vol = 0.1, lp = 8000, lpEnd = null) {
    const c = ac(); if (!c) return;
    if (!noiseBuf) { noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const t0 = c.currentTime + start;
    const src = c.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(lp, t0);
    if (lpEnd) f.frequency.exponentialRampToValueAtTime(lpEnd, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0, Math.random()); src.stop(t0 + dur + 0.02);
  }
  const kick = (t, v = 0.5) => tone(150, t, 0.11, 'triangle', v, { slide: 40, release: 0.02, sustain: 1 });
  const snare = (t, v = 0.12) => { noise(t, 0.12, v, 6000, 1500); tone(220, t, 0.05, 'triangle', v * 0.8, { slide: 120 }); };
  const hat = (t, v = 0.035) => noise(t, 0.04, v, 12000);
  // Coin pickup: a quick two-note jump up with a ringing tail.
  function coinBlip(t) {
    tone(NOTE('A5'), t, 0.06, 'p25', 0.09, { release: 0.01 });
    tone(NOTE('E6'), t + 0.06, 0.32, 'p25', 0.09, { release: 0.12, sustain: 0.6 });
  }
  // Ring-style sparkle: high tones a hair apart, detuned for shine.
  function sparkle(t) {
    [[NOTE('E7'), 0], [NOTE('B6'), 0.05], [NOTE('G#7'), 0.1]].forEach(([f, d]) => { tone(f, t + d, 0.09, 'sine', 0.05, { release: 0.15 }); tone(f * 1.006, t + d, 0.09, 'sine', 0.03, { release: 0.15 }); });
  }
  // Step reward: coins clinking in, sparkle, then a fast power-up run.
  function coinSound() {
    coinBlip(0); coinBlip(0.11); sparkle(0.2);
    ['C5', 'G5', 'E5', 'C6', 'G5', 'E6', 'C6', 'G6'].forEach((n, i) => tone(NOTE(n), 0.42 + i * 0.045, 0.05, 'p12', 0.06, { release: 0.01 }));
    tone(NOTE('C7'), 0.42 + 8 * 0.045, 0.28, 'p25', 0.07, { vibrato: true, release: 0.1 });
    noise(0.42, 0.4, 0.025, 14000, 3000);
  }
  // Original 8-bit "stage clear" fanfare (~5s): pulse lead, pulse harmony a
  // third below, triangle bass, noise-channel drums, big arpeggio finish.
  // Returns its length in seconds.
  function victoryTune() {
    const b = 0.2; // one beat
    const lead = [
      ['G4', .5], ['C5', .5], ['E5', .5], ['G5', 1], ['E5', .5], ['G5', 1],
      ['A5', .5], ['F5', .5], ['A5', .5], ['C6', 1], ['A5', .5], ['C6', 1],
      ['B5', .5], ['G5', .5], ['B5', .5], ['D6', 1], ['B5', .5], ['F6', .5], ['E6', .5],
      ['D6', .5], ['C6', .5], ['D6', .5], ['E6', 1], ['G6', 1], ['C7', 3],
    ];
    const harm = { G4: 'E4', C5: 'G4', E5: 'C5', G5: 'E5', A5: 'F5', F5: 'C5', C6: 'A5', B5: 'G5', D6: 'B5', F6: 'D6', E6: 'C6', G6: 'E6', C7: 'G6' };
    let t = 0.15;
    lead.forEach(([n, len]) => {
      const d = b * len;
      tone(NOTE(n), t, d * 0.9, 'p25', 0.075, { vibrato: len >= 1, release: 0.03 });
      tone(NOTE(harm[n]), t, d * 0.85, 'p12', 0.04, { release: 0.03 });
      t += d;
    });
    const end = t;
    // Bass: bouncing octaves under each bar (C, F, G, C).
    const bars = [['C3', 'C4'], ['F2', 'F3'], ['G2', 'G3'], ['C3', 'C4']];
    for (let i = 0, bt = 0.15; bt < end - 0.05; i++, bt += b / 2) {
      const bar = bars[Math.min(bars.length - 1, Math.floor((bt - 0.15) / (b * 4)))];
      tone(NOTE(bar[i % 2]), bt, b / 2 * 0.8, 'triangle', 0.22, { release: 0.02, sustain: 1 });
    }
    // Drums: kick on the beat, snare on 2 and 4, hats every half beat.
    for (let i = 0, dt = 0.15; dt < end - 0.05; i++, dt += b / 2) {
      if (i % 4 === 0) kick(dt);
      if (i % 4 === 2) snare(dt);
      hat(dt);
    }
    // Lead-in drum roll, then the big finish: sweep up + held chord + crash.
    for (let i = 0; i < 6; i++) snare(i * 0.025, 0.05 + i * 0.012);
    ['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7', 'E7'].forEach((n, i) => tone(NOTE(n), end + i * 0.04, 0.06, 'p12', 0.06));
    tone(NOTE('C6'), end + 0.34, 0.9, 'p25', 0.06, { vibrato: true, release: 0.4 });
    tone(NOTE('E6'), end + 0.34, 0.9, 'p12', 0.045, { vibrato: true, release: 0.4 });
    tone(NOTE('G6'), end + 0.34, 0.9, 'p12', 0.04, { vibrato: true, release: 0.4 });
    tone(NOTE('C3'), end + 0.34, 0.9, 'triangle', 0.25, { release: 0.3, sustain: 1 });
    kick(end + 0.34, 0.6); noise(end + 0.34, 1.4, 0.09, 12000, 2000);
    return end + 1.6;
  }
  // Firework: rising whistle, then a crackling boom.
  function fireworkSound(delay = 0, big = false) {
    const up = 0.32 + Math.random() * 0.2;
    tone(500 + Math.random() * 300, delay, up, 'sine', 0.025, { slide: 1800 + Math.random() * 900, release: 0.02 });
    noise(delay + up, big ? 0.9 : 0.6, big ? 0.16 : 0.1, 3500, 120);
    kick(delay + up, big ? 0.35 : 0.2);
    for (let i = 0; i < (big ? 7 : 4); i++) noise(delay + up + 0.12 + Math.random() * 0.45, 0.03, 0.05, 9000);
    return up;
  }

  // ── Effects ───────────────────────────────────────────────────────────
  function fxLayer() { const d = document.createElement('div'); d.className = 'ptu-fx'; document.body.appendChild(d); return d; }
  // Coins with ninjas and flexed arms mixed in (Lee, 2026-11-21).
  const BURST_EMOJI = ['\u{1F977}', '\u{1F4AA}'];
  function coinBurst(x, y, n = 12, layer, opts = {}) {
    const fx = layer || fxLayer();
    const coins = [];
    const spread = opts.spread ?? 1.25, power = opts.power ?? 1;
    for (let i = 0; i < n; i++) {
      const emoji = i % 3 !== 0; // a third each: coin, ninja, muscle (Lee, 2026-11-21)
      const el = document.createElement('div');
      if (emoji) { el.className = 'ptu-flyemoji'; el.textContent = BURST_EMOJI[(i % 3) - 1]; }
      else { el.className = 'ptu-flycoin spin'; el.style.animationDelay = (Math.random() * -0.35) + 's'; }
      fx.appendChild(el);
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * spread;
      const v = (5 + Math.random() * 7) * power;
      const c = { el, emoji, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, s: 1, rot: (Math.random() - 0.5) * 8, r: 0 };
      if (!emoji) { const px = 44; el.style.width = el.style.height = px + 'px'; el.style.margin = (-px / 2) + 'px 0 0 ' + (-px / 2) + 'px'; }
      coins.push(c);
    }
    const t0 = performance.now();
    let last = t0;
    (function frame(now) {
      const t = (now - t0) / 1000;
      const k = Math.min(4, Math.max(0, (now - last) / 16.67)); last = now; // 60fps steps, so slow phones keep real speed
      coins.forEach(c => {
        c.vy += 0.38 * k; c.x += c.vx * k; c.y += c.vy * k; c.r += c.rot * k;
        c.el.style.left = c.x + 'px'; c.el.style.top = c.y + 'px';
        c.el.style.opacity = Math.max(0, 1 - Math.max(0, t - 0.9) / 0.7);
        if (c.emoji) c.el.style.transform = `translate(-50%,-50%) rotate(${c.r}deg) scale(${c.s})`;
      });
      if (t < 1.6) requestAnimationFrame(frame); else if (!layer) fx.remove(); else coins.forEach(c => c.el.remove());
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
    setTimeout(() => fx.remove(), 2500);
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
    const vw = window.innerWidth;
    const bar = document.getElementById('chat-app-bottom-bar');
    const barTop = bar && visible(bar) ? bar.getBoundingClientRect().top : Infinity;
    const vh = Math.min(window.visualViewport ? window.visualViewport.height : window.innerHeight, window.innerHeight, barTop);
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
    c.querySelector('[data-a="yes"]').onclick = () => { state.active = false; state.cancelled = true; save(state); teardown(); mountLauncher(); window.dispatchEvent(new Event('pra-quickstart-done')); };
  }
  function render(sub, opts = {}) {
    teardown();
    const stepNo = state.step + 1;
    panel = document.createElement('div'); panel.className = 'ptu-panel';
    panel.innerHTML = `<div class="ptu-prog"><i></i></div><div class="ptu-body">
      <button class="ptu-x" title="Close Quick Start" aria-label="Close Quick Start">&#x2715;</button>
      <div class="ptu-head"><span>STEP ${stepNo} / ${STEPS.length}</span><span class="ptu-tally"><span class="ptu-coin"></span><b>${state.coins}</b><span style="color:#9ca3af;font-weight:600">/ ${TOTAL}</span></span></div>
      <div class="ptu-kicker"></div><div class="ptu-title"></div><div class="ptu-text"></div>
      <div class="ptu-foot"><button class="ptu-btn ghost ptu-back${(state.step || state.sub) ? ' on' : ''}">Back</button><button class="ptu-btn ptu-next">${opts.away ? 'Take me there' : 'Next'}</button></div></div>`;
    panel.querySelector('.ptu-title').textContent = sub.title;
    const kick = panel.querySelector('.ptu-kicker');
    if (sub.kicker) {
      kick.textContent = sub.kicker;
      if (sub.kickerNote) { const t = document.createElement('span'); t.className = 'ptu-kicker-note'; t.textContent = sub.kickerNote; kick.append(' ', t); }
    } else kick.remove();
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
  function back(skipping = false) {
    if (busy) return;
    if (!skipping) delete state.backing;
    const cur = STEPS[state.step].subs[state.sub];
    if (cur.closePanel) { const x = document.querySelector('.pp-backdrop.show .pp-close'); if (x) x.click(); }
    if (state.sub > 0) state.sub--;
    else if (state.step > 0) { state.step--; state.sub = STEPS[state.step].subs.length - 1; }
    else return;
    state.coins = state.step * 10; state.noSkip = true; state.backing = true;
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
    setTimeout(() => { busy = false; if (finished) { teardown(); finale(); } else show(); }, 2400);
  }

  // ── Finale: 100/100 fireworks show ────────────────────────────────────
  // Like a fireworks finale (Lee, 2026-11-21): several athletes performing at
  // once around the score, new ones swapping in as others finish, fireworks
  // building to a rapid-fire crescendo, coin + ninja + muscle showers, and the
  // 8-bit fanfare. Back to the chat when it ends.
  function finale(preview = false) {
    const wrap = document.createElement('div'); wrap.className = 'ptu-final';
    wrap.innerHTML = `<canvas></canvas><div class="box"><div class="ptu-final-stage"></div><div class="score">${TOTAL} / ${TOTAL}</div>
      <div class="msg">Quick Start complete!</div><div class="sub">You know your way around. Now go train.</div></div>`;
    document.body.appendChild(wrap);
    const SHOW_MS = 7000;
    victoryTune();
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const every = (fn, ms) => { const id = setInterval(fn, ms); timers.push(id); return id; };

    // Athletes: every step's move, in the same spread-out order as the
    // steps, performing side by side in one centered row above the score
    // (Lee, 2026-11-21), new ones swapping in as others finish.
    const order = STEPS.map(st => st.figure);
    const W = innerWidth, H = innerHeight;
    const cols = W < 560 ? 3 : 5;
    const figSize = Math.floor(Math.max(90, Math.min(150, (Math.min(W, 820) - 24) / cols, H * 0.26)));
    const stage = wrap.querySelector('.ptu-final-stage');
    stage.style.width = cols * figSize + 'px'; stage.style.height = figSize + 'px';
    // Middle spots fill first, so even two performers sit centered.
    const slots = Array.from({ length: cols }, (_, c) => ({ x: (c + 0.5) * figSize, y: figSize / 2, busy: false, d: Math.abs(c - (cols - 1) / 2) }));
    const box = wrap.querySelector('.box').getBoundingClientRect();
    const maxLive = cols;
    let live = 0, k = 0;
    const spawnFig = () => {
      if (live >= maxLive) return;
      const free = slots.filter(sl => !sl.busy);
      if (!free.length) return;
      const best = Math.min(...free.map(sl => sl.d));
      const pick = free.filter(sl => sl.d === best);
      const sl = pick[Math.floor(Math.random() * pick.length)];
      sl.busy = true; live++;
      const el = document.createElement('div'); el.className = 'ptu-fig';
      el.style.width = el.style.height = figSize + 'px';
      el.style.margin = `${-figSize / 2}px 0 0 ${-figSize / 2}px`;
      el.style.left = sl.x + 'px'; el.style.top = sl.y + 'px';
      el.innerHTML = FIGS[order[k++ % order.length]];
      stage.appendChild(el);
      setTimeout(() => { el.remove(); sl.busy = false; live--; }, 2400);
    };
    // Three at once to open, then one more every ~0.4s as spots free up.
    spawnFig(); later(spawnFig, 150); later(spawnFig, 300);
    every(spawnFig, 420);

    // Fireworks canvas.
    const cv = wrap.querySelector('canvas'), ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const parts = [], rockets = [];
    const COLORS = ['#009bff', '#ffd23f', '#ffffff', '#5cc8ff', '#ffb000', '#d4ff00', '#ff4fa3'];
    const launch = (big = false) => {
      const x = W * (0.1 + Math.random() * 0.8), ty = H * (0.1 + Math.random() * 0.38);
      const col = COLORS[Math.floor(Math.random() * COLORS.length)], col2 = COLORS[Math.floor(Math.random() * COLORS.length)];
      const up = fireworkSound(0, big);
      rockets.push({ x, y: H + 10, y0: H + 10, ty, t0: performance.now(), up: up * 1000, col, col2, big });
    };
    const explode = (rk) => {
      const n = rk.big ? 130 : 70, ring = Math.random() < 0.35;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.1, v = ring ? (rk.big ? 5.2 : 3.8) : (1.2 + Math.random() * (rk.big ? 6 : 4.5));
        parts.push({ x: rk.x, y: rk.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, col: i % 2 ? rk.col : rk.col2, size: rk.big ? 2.6 : 2.1, twinkle: Math.random() < 0.3 });
      }
    };
    // Build-up: a few at a time, then a rapid-fire finale.
    launch(true);
    const plan = [[300, 1], [800, 2], [1400, 1], [1900, 2], [2500, 2], [3000, 3], [3500, 2], [4000, 3], [4400, 3], [4800, 4], [5150, 4], [5450, 5], [5700, 6, true]];
    plan.forEach(([ms, count, big]) => later(() => { for (let i = 0; i < count; i++) setTimeout(() => launch(big || Math.random() < 0.25), i * 90); }, ms));
    // Coin, ninja and muscle showers from the score, plus from the corners late on.
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    coinBurst(cx, cy, 18);
    later(() => coinBurst(cx, cy, 14), 2200);
    later(() => { coinBurst(W * 0.15, H * 0.85, 12, null, { spread: 0.8 }); coinBurst(W * 0.85, H * 0.85, 12, null, { spread: 0.8 }); }, 4300);
    later(() => coinBurst(cx, cy, 24, null, { power: 1.3, spread: 1.6 }), 5700);
    later(() => { coinBlip(0); coinBlip(0.12); }, 2200);

    let running = true, lastT = performance.now();
    (function frame(now = performance.now()) {
      if (!running) return;
      const k = Math.min(4, Math.max(0, (now - lastT) / 16.67)); lastT = now;
      ctx.fillStyle = `rgba(4,4,8,${Math.min(0.6, 0.2 * k)})`; ctx.fillRect(0, 0, W, H);
      for (let i = rockets.length - 1; i >= 0; i--) {
        const rk = rockets[i]; const f = Math.min(1, (now - rk.t0) / rk.up); rk.y = rk.y0 + (rk.ty - rk.y0) * (1 - (1 - f) * (1 - f));
        ctx.globalAlpha = 1; ctx.fillStyle = '#fff6c2'; ctx.beginPath(); ctx.arc(rk.x, rk.y, 2, 0, Math.PI * 2); ctx.fill();
        if (f >= 1) { explode(rk); rockets.splice(i, 1); }
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; const drag = Math.pow(0.985, k); p.vy += 0.045 * k; p.vx *= drag; p.vy *= drag; p.x += p.vx * k; p.y += p.vy * k; p.life -= 0.011 * k;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        ctx.globalAlpha = p.twinkle ? p.life * (0.4 + Math.random() * 0.6) : p.life; ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    })();
    const close = () => { running = false; timers.forEach(id => { clearTimeout(id); clearInterval(id); }); wrap.remove(); if (preview) return; mountLauncher(); window.dispatchEvent(new Event('pra-quickstart-done')); };
    // After the show, straight back to the chat.
    later(() => { wrap.style.transition = 'opacity .5s'; wrap.style.opacity = '0'; setTimeout(() => { close(); if (!preview && !PAGES.chat.test(path)) location.href = PAGES.chat.url; }, 500); }, SHOW_MS);
  }

  function markComplete() {
    QS.completed = true; QS.showButton = true;
    fetch('/api/chat/quickstart/complete', { method: 'POST' }).catch(() => {});
  }

  // ── Flow control ──────────────────────────────────────────────────────
  function pageMatches(key) { return key === '*' || (PAGES[key] && PAGES[key].test(path)); }
  // A part that does not apply here (phone-only on a computer, its button not
  // on screen) is skipped in the direction they were going: Back keeps going
  // back past it -- it used to skip forward again, so Back at step 2 looked dead.
  function skipSub() {
    if (state.backing && (state.step > 0 || state.sub > 0)) { back(true); return; }
    shown(); advanceSub(true);
  }
  function shown() { if (state.backing) { delete state.backing; save(state); } }
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
    if (!pageMatches(sub.page)) { shown(); render(sub, { away: true }); return; }
    // Phone-only parts are skipped on bigger screens.
    if (sub.phoneOnly && !isPhone()) { skipSub(); return; }
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
      if (!sub.targets.length || findTarget(sub)) { shown(); render(sub); return; }
      if (Date.now() - t0 > limit) { if (skippable) skipSub(); else { shown(); render(sub); } return; }
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
  let launcherTimer = null;
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
    if (!bar) { if (b.parentElement) b.remove(); return; }
    if (b.parentElement !== bar) { if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative'; bar.appendChild(b); }
    if (wide) {
      // Desktop: centered in the top bar.
      b.classList.add('in-bar'); b.classList.remove('in-bar-right'); b.style.top = '';
    } else {
      // Phone: top-right corner, on the same line as the logo.
      b.classList.add('in-bar-right'); b.classList.remove('in-bar');
      const logo = bar.querySelector('.cah-label');
      const br = bar.getBoundingClientRect(), lr = logo ? logo.getBoundingClientRect() : null;
      if (lr && lr.height) { b.style.visibility = ''; b.style.top = (lr.top - br.top + lr.height / 2) + 'px'; }
      else b.style.visibility = 'hidden'; // logo line not on screen right now
    }
    // The header re-lays itself out (opening/closing a chat, safe areas...):
    // keep following the logo line instead of measuring once.
    if (!launcherTimer) launcherTimer = setInterval(() => { if (document.querySelector('.ptu-launch')) mountLauncher(); else { clearInterval(launcherTimer); launcherTimer = null; } }, 400);
  }
  window.addEventListener('resize', () => { if (document.querySelector('.ptu-launch')) mountLauncher(); });

  // Preview the celebrations without touching anyone's progress:
  // PRATutorial.previewReward(0..9) / PRATutorial.previewFinale().
  const previewAnchor = () => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:50%;top:62%;width:1px;height:1px'; document.body.appendChild(d); setTimeout(() => d.remove(), 3000); return d; };
  window.PRATutorial = { start, reset: () => { try { localStorage.removeItem(KEY); } catch {} },
    previewReward: (i = 0) => stepReward(Math.max(0, Math.min(STEPS.length - 1, i)), previewAnchor()),
    previewFinale: () => finale(true) };
  const boot = () => {
    if (new URLSearchParams(location.search).get('tutorial') === '1') { start(); return; }
    if (state && state.done && !QS.completed) markComplete();
    // A new app open (not just moving between pages): an unfinished game
    // starts over from step 1.
    let freshOpen = false;
    try { freshOpen = !sessionStorage.getItem('praQS.open'); sessionStorage.setItem('praQS.open', '1'); } catch {}
    if (freshOpen && state && state.active) { state = null; try { localStorage.removeItem(KEY); } catch {} if (QS.autoStart && !QS.completed) { start(); return; } }
    if (state && state.active) { show(); return; }
    mountLauncher();
    // First day(s): opens on every app open until finished, even after the X.
    // After that: opens until finished unless they closed it.
    const wantStart = QS.forceStart ? freshOpen : (QS.autoStart && !QS.completed && !(state && (state.cancelled || state.done)));
    // On a fresh open it starts wherever the app landed (trainees open on their
    // protocol; start() takes them to chat). Later page loads only start on chat.
    if (wantStart && !QS.completed && (PAGES.chat.test(path) || freshOpen)) start();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
