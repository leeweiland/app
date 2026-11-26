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
  function startMeter(getCanvas) {
    try {
      if (!audioCtx || !getCanvas) return;
      // Phones create audio "suspended" unless started from the tap itself;
      // a suspended context reads pure silence (the flat dotted line).
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let last = 0;
      levels = [];
      const tick = (t) => {
        raf = requestAnimationFrame(tick);
        if (t - last < 70) return;
        last = t;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const x = (data[i] - 128) / 128; sum += x * x; }
        // sqrt makes normal speech (rms ~0.02-0.1) show clearly tall bars.
        levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / data.length)) * 1.9));
        if (levels.length > 300) levels.shift();
        const cv = getCanvas();
        if (cv) paint(cv);
      };
      raf = requestAnimationFrame(tick);
    } catch {}
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
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(250);
    startedAt = Date.now();
    if (onTick) { onTick(0); timer = setInterval(() => onTick(Math.floor((Date.now() - startedAt) / 1000)), 250); }
    startMeter(getCanvas);
  }
  function stop() {
    return new Promise((resolve) => {
      if (!rec) { resolve(null); return; }
      const r = rec, type = r.mimeType || mime || 'audio/webm';
      r.onstop = () => { const blob = new Blob(chunks, { type }); cleanup(); resolve(blob.size ? blob : null); };
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
  window.PRAVoiceNote = { start, stop, cancel, transcribe, fmt, isRecording: () => !!rec };
})();
