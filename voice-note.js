// Voice note recorder (Lee, 2026-11-26): staff tap the mic, it records right
// away; trash = stop + throw away, Send = stop + transcribe + send as text.
// Same file in chat-app and crm-app. Exposes window.PRAVoiceNote.
(function () {
  let rec = null, stream = null, chunks = [], startedAt = 0, timer = 0, mime = '';
  let audioCtx = null, raf = 0, levels = [];
  // Simple scrolling waveform: one bar per ~70ms of mic level, newest on the
  // right, drawn into whatever canvas getCanvas() returns (re-asked every
  // frame, so a re-rendered page still gets it).
  function paint(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const bw = 3, gap = 2, n = Math.floor(w / (bw + gap));
    const vals = levels.slice(-n);
    g.fillStyle = '#009bff';
    vals.forEach((lv, i) => {
      const bh = Math.max(2, Math.min(h, lv * h));
      const x = w - (vals.length - i) * (bw + gap);
      g.beginPath();
      if (g.roundRect) g.roundRect(x, (h - bh) / 2, bw, bh, 1.5); else g.rect(x, (h - bh) / 2, bw, bh);
      g.fill();
    });
  }
  // Two level sources, so the bars move on every phone:
  //  1. Web Audio analyser on the mic (smooth, real loudness). Some Android
  //     WebViews hand it pure silence even while the recording is fine, so
  //  2. if it reads dead flat for ~1.2s, switch to how many bytes the
  //     recorder captured in each 100ms slice -- Opus packs silence into
  //     almost nothing and speech into much more, so it tracks talking.
  let meterMode = 'analyser', analyserAlive = false, sizeMin = Infinity, sizeMax = 0, paintCanvas = null;
  function pushLevel(lv) {
    levels.push(Math.max(0, Math.min(1, lv)));
    if (levels.length > 300) levels.shift();
  }
  let chunkN = 0;
  function onChunkSize(size) {
    if (++chunkN <= 2) return; // the first slices carry the file header
    sizeMin = Math.min(sizeMin, size);
    sizeMax = Math.max(sizeMax, size, sizeMin + 60);
    if (meterMode !== 'bytes') return;
    const lv = Math.sqrt((size - sizeMin) / (sizeMax - sizeMin));
    pushLevel(0.08 + lv * 0.92);
  }
  async function startMeter(getCanvas) {
    paintCanvas = getCanvas;
    meterMode = 'analyser'; analyserAlive = false; sizeMin = Infinity; sizeMax = 0; chunkN = 0; levels = [];
    let analyser = null, data = null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && getCanvas && stream) {
        // Match the mic's own sample rate -- a mismatch reads silence on
        // some Android devices. The context made during the tap stays as
        // the "unlock"; if its rate differs, a matching one replaces it.
        const rate = stream.getAudioTracks()[0]?.getSettings?.().sampleRate;
        if (!audioCtx || (rate && audioCtx.sampleRate !== rate)) {
          try { const ctx2 = rate ? new AC({ sampleRate: rate }) : new AC(); if (audioCtx) audioCtx.close().catch(() => {}); audioCtx = ctx2; } catch {}
        }
        if (audioCtx && audioCtx.state !== 'running') await audioCtx.resume().catch(() => {});
        if (audioCtx) {
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          audioCtx.createMediaStreamSource(stream).connect(analyser);
          data = new Float32Array(analyser.fftSize);
        }
      }
    } catch { analyser = null; }
    if (!analyser) meterMode = 'bytes';
    const began = performance.now();
    let last = 0;
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 70) return;
      last = t;
      if (meterMode === 'analyser') {
        analyser.getFloatTimeDomainData(data);
        let sum = 0, peak = 0;
        for (let i = 0; i < data.length; i++) { const x = data[i]; sum += x * x; const a = Math.abs(x); if (a > peak) peak = a; }
        if (peak > 0.0005) analyserAlive = true;
        if (!analyserAlive && t - began > 1200) { meterMode = 'bytes'; return; }
        // sqrt-of-sqrt makes normal speech (rms ~0.02-0.1) clearly tall.
        pushLevel(Math.sqrt(Math.sqrt(sum / data.length)) * 1.9);
      }
      const cv = paintCanvas && paintCanvas();
      if (cv) paint(cv);
    };
    raf = requestAnimationFrame(tick);
  }
  const pickMime = () => {
    const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return (window.MediaRecorder && opts.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t))) || '';
  };
  function cleanup() {
    clearInterval(timer); timer = 0;
    cancelAnimationFrame(raf); raf = 0;
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    levels = [];
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; rec = null; chunks = [];
  }
  async function start(onTick, getCanvas) {
    if (rec) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Voice notes need microphone access, which this browser does not support.');
    // Created right here, still inside the tap, so the phone lets it run.
    try { const AC = window.AudioContext || window.webkitAudioContext; if (AC && getCanvas) { audioCtx = new AC(); audioCtx.resume().catch(() => {}); } } catch { audioCtx = null; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { cleanup(); throw e; }
    mime = pickMime();
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); onChunkSize(e.data.size); } };
    rec.start(100);
    startedAt = Date.now();
    if (onTick) { onTick(0); timer = setInterval(() => onTick(Math.floor((Date.now() - startedAt) / 1000)), 250); }
    startMeter(getCanvas);
  }
  function stop() {
    return new Promise((resolve) => {
      if (!rec) { resolve(null); return; }
      const r = rec, type = r.mimeType || mime || 'audio/webm';
      // The recorded mic levels ride along as the voice note's waveform.
      const lv = levels.slice(), secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      r.onstop = () => { const blob = new Blob(chunks, { type }); cleanup(); if (blob.size) { blob.levels = lv; blob.duration = secs; } resolve(blob.size ? blob : null); };
      try { r.stop(); } catch { cleanup(); resolve(null); }
    });
  }
  function cancel() {
    if (rec) { try { rec.onstop = null; rec.stop(); } catch {} }
    cleanup();
  }
  // POSTs the audio to the app's own transcribe endpoint; returns the text.
  async function transcribe(blob, url) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Could not transcribe that voice note');
    return String(d.text || '').trim();
  }
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  // Recorded levels -> n bars (0..1), loudest bar = 1.
  function peaks(lv, n = 48) {
    lv = (lv || []).filter(x => Number.isFinite(x));
    if (!lv.length) return Array.from({ length: n }, () => 0.3);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * lv.length / n), b = Math.max(a + 1, Math.floor((i + 1) * lv.length / n));
      out.push(Math.max(...lv.slice(a, b)));
    }
    const mx = Math.max(...out) || 1;
    return out.map(x => Math.round(Math.max(0.08, x / mx) * 100) / 100);
  }
  window.PRAVoiceNote = { start, stop, cancel, transcribe, fmt, peaks, isRecording: () => !!rec };
})();
