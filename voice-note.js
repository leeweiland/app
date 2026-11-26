// Voice note recorder (Lee, 2026-11-26): staff tap the mic, it records right
// away; trash = stop + throw away, Send = stop + transcribe + send as text.
// Same file in chat-app and crm-app. Exposes window.PRAVoiceNote.
(function () {
  let rec = null, stream = null, chunks = [], startedAt = 0, timer = 0, mime = '';
  const pickMime = () => {
    const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return (window.MediaRecorder && opts.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t))) || '';
  };
  function cleanup() {
    clearInterval(timer); timer = 0;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; rec = null; chunks = [];
  }
  async function start(onTick) {
    if (rec) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Voice notes need microphone access, which this browser does not support.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    mime = pickMime();
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(250);
    startedAt = Date.now();
    if (onTick) { onTick(0); timer = setInterval(() => onTick(Math.floor((Date.now() - startedAt) / 1000)), 250); }
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
