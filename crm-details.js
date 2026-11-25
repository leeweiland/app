// Admin "Details" panel (Lee, 2026-11-24): the student's CRM contact card --
// the same contact info, status, custom-field groups and color-coded
// enrollment / renewal / hold history as the CRM's contact popup, read live
// from the CRM (/api/chat/crm-details) and saved straight back to it field by
// field. Refreshes while open, so a change made in the CRM shows up here.
// Enrolled / On Hold keep their own popups: On Hold opens the app's hold
// form (window.praOpenHold), Enrolled points to the CRM's Enrolled popup.
window.PRADetails = (function () {
  const css = `
  /* 95% of the visible screen on every side (inside the phone's status / nav bars) */
  .modal-backdrop.pdt-backdrop { padding: calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 2.5vh) calc(var(--safe-area-inset-right, env(safe-area-inset-right, 0px)) + 2.5vw) calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 2.5vh) calc(var(--safe-area-inset-left, env(safe-area-inset-left, 0px)) + 2.5vw); }
  .modal-box.pdt-box { width: 100%; max-width: none; height: 100%; max-height: none; overflow-y: auto; padding: 16px 18px 20px; box-sizing: border-box; color: #fff; margin: 0; font-family: var(--font-primary); }
  .pdt-box .pdt-name, .pdt-box .pdt-dates { color: #fff; font-family: var(--font-primary); }
  .pdt-box .pdt-sec-head, .pdt-box .pdt-kind, .pdt-box .pdt-now { font-family: var(--font-secondary, var(--font-primary)); }
  /* name + X on the first line (X in the top-right corner), status right under the name */
  .pdt-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name x" "status ."; align-items: center; gap: 8px 10px; margin: -16px -18px 12px; padding: 14px 18px 10px; position: sticky; top: -16px; z-index: 2; background: var(--pra-panel, #101014); border-bottom: 1px solid #26262d; }
  .pdt-name { grid-area: name; font-weight: 800; font-size: 1.05rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pdt-status-row { grid-area: status; display: flex; gap: 8px; align-items: center; min-width: 0; }
  .pdt-head select { width: min(100%, 340px); min-width: 0; }
  .pdt-enroll-btn { flex: 0 0 auto; font: inherit; font-size: .8rem; font-weight: 700; color: #fff; padding: 9px 12px; border-radius: 9px; border: 1.5px solid #22c55e; background: rgba(34,197,94,.14); box-shadow: 0 0 8px rgba(34,197,94,.45); cursor: pointer; white-space: nowrap; }
  .pdt-enroll-btn:hover { background: rgba(34,197,94,.26); }
  /* the CRM's Enrolled / Hold popups (loaded from the CRM) on top of this panel */
  .enroll-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; z-index: 700; padding: 16px; box-sizing: border-box; font-family: var(--font-primary); color: #fff; }
  .enroll-modal-backdrop.show { display: flex; }
  .enroll-modal-backdrop .modal-box { width: 100%; max-width: 480px; max-height: 90vh; max-height: 90dvh; overflow-y: auto; padding: 22px; box-sizing: border-box; }
  .enroll-modal-backdrop *, .enroll-modal-backdrop *::before, .enroll-modal-backdrop *::after { box-sizing: border-box; }
  .enroll-modal-backdrop .field { margin-bottom: 14px; }
  .enroll-modal-backdrop .field-row { display: flex; gap: 10px; } .enroll-modal-backdrop .field-row .field { flex: 1; min-width: 0; }
  .enroll-kind-toggle { display: flex; border: 1px solid #383842; border-radius: 8px; overflow: hidden; }
  .enroll-kind-option { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 6px; font-size: .84rem; font-weight: 700; cursor: pointer; color: #9aa0aa; background: rgba(255,255,255,.03); border-right: 1px solid #383842; }
  .enroll-kind-option:last-child { border-right: none; }
  .enroll-kind-option input { position: absolute; opacity: 0; pointer-events: none; }
  .enroll-kind-option.checked { background: #009bff; color: #fff; }
  .pdt-head .pdt-saved { grid-column: 1 / -1; grid-row: 3; min-width: 0; }
  .pdt-head .pdt-saved:empty { display: none; }
  .pdt-x { grid-area: x; justify-self: end; align-self: start; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.06); border: 1px solid #383842; border-radius: 50%; color: #fff; font-size: 1.35rem; cursor: pointer; padding: 0; line-height: 1; }
  .pdt-x:hover { border-color: #ff6b6b; color: #ff6b6b; }
  @media (max-width: 560px) {
    .pdt-head { grid-template-areas: "name x" "status status"; }
    .pdt-head select { width: 100%; }
  }
  .pdt-sec { border: 1px solid #383842; border-radius: 12px; padding: 12px 12px 4px; margin-bottom: 12px; }
  .pdt-sec-head { font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--pra-dim, #9aa0aa); margin-bottom: 10px; }
  .pdt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .pdt-grid .field { margin-bottom: 10px; min-width: 0; }
  .pdt-box .pra-input { box-sizing: border-box; max-width: 100%; min-width: 0; }
  .pdt-box *, .pdt-box *::before, .pdt-box *::after { box-sizing: border-box; }
  .pdt-grid .field.full { grid-column: 1 / -1; }
  .pdt-grid textarea { resize: vertical; min-height: 38px; }
  @media (max-width: 560px) { .pdt-grid { grid-template-columns: 1fr; } }
  .pdt-saved { font-size: .72rem; color: #4ade80; min-width: 3em; }
  .pdt-more { cursor: pointer; color: var(--pra-dim, #9aa0aa); font-size: .78rem; background: none; border: 0; padding: 0 0 10px; }
  .pdt-terms { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .pdt-term { border: 1px solid #383842; border-left: 3px solid #383842; border-radius: 9px; padding: 8px 11px; }
  .pdt-term.k-enrollment { border-left-color: #22c55e; } .pdt-term.k-renewal { border-left-color: #009bff; }
  .pdt-term.k-hold { border-left-color: #ff9f1c; } .pdt-term.k-travel { border-left-color: #a78bfa; } .pdt-term.k-payment { border-left-color: #6b7280; }
  .pdt-term.current { box-shadow: inset 0 0 0 1px rgba(255,255,255,.10); }
  .pdt-term-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pdt-kind { font-size: .62rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; padding: 2px 8px; border-radius: 9px; background: rgba(0,155,255,.14); color: #4db8ff; }
  .pdt-kind.k-enrollment { background: rgba(34,197,94,.14); color: #4ade80; } .pdt-kind.k-hold { background: rgba(255,159,28,.16); color: #ffb44d; }
  .pdt-kind.k-travel { background: rgba(167,139,250,.16); color: #c4b5fd; } .pdt-kind.k-payment { background: rgba(107,114,128,.2); color: #b4b9c2; }
  .pdt-now { font-size: .62rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; opacity: .7; }
  .pdt-meta { font-size: .72rem; color: var(--pra-dim, #9aa0aa); }
  .pdt-dates { font-size: .86rem; font-weight: 700; margin-top: 4px; }
  .pdt-sub { font-size: .72rem; color: var(--pra-dim, #9aa0aa); margin-top: 2px; }
  label.pra-label.pdt-end-hold { color: #ffb44d; }
  .pdt-msg { font-size: .8rem; color: var(--pra-dim, #9aa0aa); padding: 20px 0; text-align: center; }`;
  let styled = false, box = null, state = null, timer = null;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Same groups as the CRM contact popup (inbox.html OV_CF_GROUPS).
  const LONG_RE = /^(CAREER|CURRENT SITUATION\??|GOALS|INJURIES|READY TODAY\??|READYINESS LEVEL|READINESS LEVEL|WHAT HAVE THEY TRIED\??|WHAT HELP DO THEY WANT\??|PERSONALITY TYPE|STRESS)$/i;
  const GROUPS = [
    { title: "Program", re: /^TYPE$/i },
    { title: "Enrollment, renewals, travel", re: /^(START DATE|END DATE)$|ENROLL|RENEW|TRAVEL|RETREAT/i, history: true },
    { title: "Application", re: /^(APPLIED WHEN\??|WILL SCHEDULE|BIRTHDAY|AGE|HEIGHT|WEIGHT|AGE, HEIGHT, WEIGHT, ETC\.?|T SHIRT SIZE|FOOD RESTRICTIONS|FAMILY NAME|FAMILY MEMBERS)$/i, alsoLong: true },
    { title: "Income", re: /INCOME/i },
    { title: "More fields", re: /.*/, collapsed: true },
  ];

  function historyHtml(c) {
    const hist = Array.isArray(c.enrollmentHistory) ? c.enrollmentHistory : [];
    if (!hist.length) return "";
    const d = v => { if (!v) return ""; const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T12:00:00" : v); return isNaN(t) ? String(v) : t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };
    const ms = v => { if (!v) return NaN; return new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T12:00:00" : v).getTime(); };
    const money = v => { const n = Number(String(v || "").replace(/[^0-9.]/g, "")); return n ? "$" + n.toLocaleString("en-US") : ""; };
    const first = hist.find(e => /^(enrollment|renewal)$/i.test(e.kind || "enrollment"));
    const now = Date.now();
    return `<div class="pdt-terms">${[...hist].reverse().map(e => {
      let kind = String(e.kind || "enrollment").toLowerCase();
      if (e === first) kind = "enrollment"; else if (kind === "enrollment") kind = "renewal";
      const meta = [e.programType ? String(e.programType).toUpperCase() : "", e.program || "", e.reason || ""].filter(Boolean).join(" · ");
      const paid = [money(e.amount), e.payment || ""].filter(Boolean).join(" · ");
      const who = e.source === "sheet" ? "from the BUYERS sheet" : e.source === "tracker" ? "from the coach trackers" : (e.by ? `recorded by ${e.by}` : "");
      const s = ms(e.start), en = ms(e.end);
      const cur = s <= now && (isNaN(en) || now <= en) && kind !== "payment" && kind !== "travel";
      const start = d(e.start) ? (e.startEstimated ? "~" : "") + d(e.start) : "?";
      return `<div class="pdt-term k-${esc(kind)}${cur ? " current" : ""}">
        <div class="pdt-term-top"><span class="pdt-kind k-${esc(kind)}">${esc(kind)}</span>${cur ? '<span class="pdt-now">now</span>' : ""}${meta ? `<span class="pdt-meta">${esc(meta)}</span>` : ""}</div>
        <div class="pdt-dates">${esc(start)}${kind === "payment" ? "" : ` &rarr; ${esc(d(e.end) || (kind === "hold" ? "open" : "?"))}`}</div>
        ${paid || who ? `<div class="pdt-sub">${esc([paid, who].filter(Boolean).join(" · "))}</div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }

  function input(key, label, val, opts = {}) {
    const attrs = `data-k="${esc(key)}"${opts.cf ? ' data-cf="1"' : ""}`;
    const lbl = `<label class="pra-label${opts.labelClass ? " " + opts.labelClass : ""}">${esc(label)}</label>`;
    return opts.long
      ? `<div class="field full">${lbl}<textarea class="pra-input" rows="2" ${attrs}>${esc(val)}</textarea></div>`
      : `<div class="field">${lbl}<input class="pra-input" ${attrs} value="${esc(val)}"/></div>`;
  }

  function render() {
    const { contact: c, fields, statuses } = state;
    const cf = c.customFields || {};
    const onHold = String(c.status || "").toUpperCase() === "ON HOLD";
    const used = new Set();
    let secs = `<div class="pdt-sec"><div class="pdt-sec-head">Contact</div><div class="pdt-grid">
      ${input("first", "First", c.first)}${input("last", "Last", c.last)}${input("email", "Email", c.email)}${input("phone", "Phone", c.phone)}
    </div></div>`;
    for (const g of GROUPS) {
      const lbl = f => String(f.label || "").trim();
      let fs = fields.filter(f => !used.has(f.id) && (g.re.test(lbl(f)) || (g.alsoLong && LONG_RE.test(lbl(f)))));
      const hist = g.history ? historyHtml(c) : "";
      if (!fs.length && !hist) continue;
      fs.forEach(f => used.add(f.id));
      fs = [...fs.filter(f => /^APPLIED WHEN/i.test(lbl(f))), ...fs.filter(f => !/^APPLIED WHEN/i.test(lbl(f)) && !LONG_RE.test(lbl(f))), ...fs.filter(f => LONG_RE.test(lbl(f)))];
      const grid = fs.map(f => {
        const endHold = /^END DATE$/i.test(lbl(f)) && onHold;
        return input(f.id, endHold ? "END DATE (HOLD)" : f.label, cf[f.id] || "", { cf: true, long: LONG_RE.test(lbl(f)), labelClass: endHold ? "pdt-end-hold" : "" });
      }).join("");
      if (g.collapsed) secs += `<div class="pdt-sec"><button class="pdt-more" data-more>${esc(g.title)} (${fs.length}) &#9662;</button><div class="pdt-grid" data-more-body style="display:none">${grid}</div></div>`;
      else secs += `<div class="pdt-sec"><div class="pdt-sec-head">${esc(g.title)}</div>${hist}<div class="pdt-grid">${grid}</div></div>`;
    }
    const opts = [...new Set([...(statuses || []), c.status].filter(Boolean))].map(s => `<option ${s === c.status ? "selected" : ""}>${esc(s)}</option>`).join("");
    box.querySelector(".pdt-box").innerHTML = `
      <div class="pdt-head">
        <div class="pdt-name">${esc(`${c.first || ""} ${c.last || ""}`.trim() || "Contact")}</div>
        <span class="pdt-saved" id="pdtSaved"></span>
        <div class="pdt-status-row"><select class="pra-input" id="pdtStatus"><option value=""></option>${opts}</select>${/^(ENROLLED|ON HOLD)$/i.test(c.status || "") ? `<button type="button" class="pdt-enroll-btn" id="pdtEnrollBtn" title="Record a renewal, travel or new enrollment">Renewal / Travel</button>` : ""}</div>
        <button class="pdt-x" title="Close" data-close>&times;</button>
      </div>${secs}`;
    wire();
  }

  async function save(body) {
    const el = box.querySelector("#pdtSaved");
    el.style.color = ""; el.textContent = "Saving...";
    try {
      const r = await fetch("/api/chat/crm-details", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId: state.contact.id, ...body }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not save");
      if (d.contact) state.contact = { ...state.contact, ...d.contact };
      el.textContent = "Saved"; setTimeout(() => { if (el.textContent === "Saved") el.textContent = ""; }, 1500);
      return true;
    } catch (e) { el.style.color = "#ff6b6b"; el.textContent = e.message; return false; }
  }

  function wire() {
    box.querySelector("[data-close]").onclick = close;
    box.querySelectorAll("[data-more]").forEach(b => b.onclick = () => { const body = b.nextElementSibling; body.style.display = body.style.display === "none" ? "" : "none"; });
    box.querySelectorAll("[data-k]").forEach(el => {
      el.addEventListener("input", () => { el.dataset.dirty = "1"; });
      el.addEventListener("change", async () => {
        const k = el.dataset.k, v = el.value;
        const ok = await save(el.dataset.cf ? { customFieldsPatch: { [k]: v } } : { [k]: v });
        if (ok) { delete el.dataset.dirty; if (el.dataset.cf) state.contact.customFields = { ...(state.contact.customFields || {}), [k]: v }; else state.contact[k] = v; }
      });
    });
    const sel = box.querySelector("#pdtStatus");
    sel.onchange = async () => {
      const v = sel.value, prev = state.contact.status || "";
      // Enrolled / On Hold: the CRM's own popups (sale recording, end-date move).
      if (/^(ON HOLD|ENROLLED)$/i.test(v)) { sel.value = prev; openCrmPopup(/^ON HOLD$/i.test(v) ? "hold" : "enroll"); return; }
      if (await save({ status: v })) { state.contact.status = v; render(); } else sel.value = prev;
    };
    const eb = box.querySelector("#pdtEnrollBtn");
    if (eb) eb.onclick = () => openCrmPopup("enroll");
  }

  // Loads the CRM's enroll-popup.js / hold-popup.js (fetched from the CRM, so
  // they're always the CRM's current code) and points their API calls at the
  // app's admin-only CRM proxy.
  let popupsReady = null;
  function loadCrmPopups() {
    window.PRA_CRM_API_BASE = "/api/chat/crm-proxy";
    if (!popupsReady) popupsReady = Promise.all([["enroll-popup", "EnrollPopup"], ["hold-popup", "HoldPopup"]].map(([file, g]) => new Promise((res, rej) => {
      if (window[g]) return res();
      const s = document.createElement("script");
      s.src = `/api/chat/crm-script/${file}.js`;
      s.onload = () => window[g] ? res() : rej(new Error("CRM popup did not load"));
      s.onerror = () => rej(new Error("Could not load the CRM popup"));
      document.head.appendChild(s);
    }))).catch(e => { popupsReady = null; throw e; });
    return popupsReady;
  }
  async function openCrmPopup(which) {
    const el = box && box.querySelector("#pdtSaved");
    try {
      await loadCrmPopups();
      const opts = { onCommitted: () => { if (state) load(true); } };
      if (which === "hold") window.HoldPopup.open(state.contact.id, opts);
      else window.EnrollPopup.open(state.contact.id, opts);
    } catch (e) { if (el) { el.style.color = "#ff6b6b"; el.textContent = e.message; } }
  }

  async function load(initial) {
    try {
      const r = await fetch(`/api/chat/crm-details?appUserId=${encodeURIComponent(state.user.id)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Could not load the CRM contact");
      if (!box) return;
      // live refresh: never re-render under someone mid-edit
      const busy = box.querySelector("[data-dirty]") || (document.activeElement && box.contains(document.activeElement) && document.activeElement.matches("input,textarea,select"));
      const changed = JSON.stringify([d.contact, d.fields]) !== JSON.stringify([state.contact, state.fields]);
      Object.assign(state, d);
      if (initial || (changed && !busy)) render();
    } catch (e) { if (initial && box) box.querySelector(".pdt-box").innerHTML = `<div class="pdt-head"><div class="pdt-name">${esc(`${state.user.first || ""} ${state.user.last || ""}`.trim())}</div><button class="pdt-x" data-close>&times;</button></div><div class="pdt-msg">${esc(e.message)}</div>`, box.querySelector("[data-close]").onclick = close; }
  }

  function close() {
    clearInterval(timer); timer = null;
    window.removeEventListener("focus", onFocus);
    if (box) box.remove(); box = null; state = null;
  }
  function onFocus() { if (state) load(false); }

  function open(user) {
    if (!user) return;
    if (!styled) { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); styled = true; }
    close();
    state = { user, contact: {}, fields: [], statuses: [] };
    box = document.createElement("div");
    box.className = "modal-backdrop show pdt-backdrop";
    box.innerHTML = `<div class="pra-panel modal-box pdt-box"><div class="pdt-msg">Loading the CRM contact...</div></div>`;
    box.addEventListener("click", e => { if (e.target === box) close(); });
    document.body.appendChild(box);
    load(true);
    timer = setInterval(() => { if (!document.hidden) load(false); }, 20000);
    window.addEventListener("focus", onFocus);
  }
  return { open, close };
})();
