// multipart_util.js — shared "one photo field + arbitrary text fields"
// multipart-parsing helper. Was duplicated in body_analysis_backend.js;
// needed again for progress photos and food-log photos, so it lives here
// once instead of copy-pasted a second and third time.

import Busboy from "busboy";

export function parseMultipartUpload(req, { fileFieldName = "photo", maxFileSize = 25 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: maxFileSize } });
    const fields = {};
    let image = null;
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("file", (name, stream, info) => {
      if (name !== fileFieldName) { stream.resume(); return; }
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => { image = { buffer: Buffer.concat(chunks), mimeType: info.mimeType }; });
    });
    bb.on("finish", () => resolve({ fields, image }));
    bb.on("error", reject);
    req.pipe(bb);
  });
}
