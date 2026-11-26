// Voice note -> text (Lee, 2026-11-26). Reads the raw audio body of the
// request (what voice-note.js POSTs) and transcribes it with OpenAI.
// Same file in chat-app and crm-app.
export async function transcribeRequestAudio(req, maxBytes = 24 * 1024 * 1024) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Transcription isn't set up (no OpenAI key)");
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > maxBytes) throw new Error("That voice note is too long -- keep it under about 10 minutes");
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error("No audio was received");
  const ct = String(req.headers["content-type"] || "audio/webm").split(";")[0].trim();
  const ext = /mp4|m4a|aac/.test(ct) ? "m4a" : /ogg/.test(ct) ? "ogg" : /wav/.test(ct) ? "wav" : /mpeg|mp3/.test(ct) ? "mp3" : "webm";
  let lastErr = "Could not transcribe";
  for (const model of ["gpt-4o-transcribe", "whisper-1"]) {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: ct }), "voice-note." + ext);
    fd.append("model", model);
    try {
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: fd,
        signal: AbortSignal.timeout(120000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return String(d.text || "").trim();
      lastErr = d.error?.message || `OpenAI ${r.status}`;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}
