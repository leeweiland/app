// Admin "Details" panel (Lee, 2026-11-24): the student's CRM contact card --
// the same contact info, status, custom-field groups and color-coded
// enrollment / renewal / hold history as the CRM's contact popup, read live
// from the CRM (/api/chat/crm-details) and saved straight back to it field by
// field. Refreshes while open, so a change made in the CRM shows up here.
// Enrolled / On Hold keep their own popups: On Hold opens the app's hold
// form (window.praOpenHold), Enrolled points to the CRM's Enrolled popup.
window.PRADetails = (function () {
  const css = `
  .modal-box.pdt-box { width: min(760px, 100%); max-width: 760px; max-height: calc(100vh - 32px); overflow-y: auto; padding: 16px 18px 20px; box-sizing: border-box; color: #fff; }
  .pdt-box .pdt-name, .pdt-box .pdt-dates { color: #fff; font-family: inherit; }
  .pdt-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .pdt-name { font-weight: 800; font-size: 1.05rem; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pdt-head select { width: auto; min-width: 120px; flex: 0 0 auto; }
  .pdt-head a.pra-btn { flex: 0 0 auto; white-space: nowrap; }
  .pdt-x { background: none; border: 0; color: var(--pra-dim, #9aa0aa); font-size: 1.3rem; cursor: pointer; padding: 0 4px; line-height: 1; }
  .pdt-sec { border: 1px solid #383842; border-radius: 12px; padding: 12px 12px 4px; margin-bottom: 12px; }
  .pdt-sec-head { font-size: .68rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--pra-dim, #9aa0aa); margin-bottom: 10px; }
  .pdt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .pdt-grid .field { margin-bottom: 10px; min-width: 0; }
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
        <select class="pra-input" id="pdtStatus"><option value=""></option>${opts}</select>
        <a class="pra-btn pra-btn-ghost" href="${esc(state.crmUrl)}" target="_blank" rel="noopener" style="padding:6px 10px;font-size:.78rem">Open in CRM</a>
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
      if (/^ON HOLD$/i.test(v)) { sel.value = prev; const u = state.user; close(); window.praOpenHold && window.praOpenHold(u); return; }
      if (/^ENROLLED$/i.test(v)) { sel.value = prev; const el = box.querySelector("#pdtSaved"); el.style.color = "#ffb44d"; el.textContent = "Record enrollments with the CRM's Enrolled popup (Open in CRM)"; return; }
      if (await save({ status: v })) { state.contact.status = v; render(); } else sel.value = prev;
    };
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
    box.className = "modal-backdrop show";
    box.innerHTML = `<div class="pra-panel modal-box pdt-box"><div class="pdt-msg">Loading the CRM contact...</div></div>`;
    box.addEventListener("click", e => { if (e.target === box) close(); });
    document.body.appendChild(box);
    load(true);
    timer = setInterval(() => { if (!document.hidden) load(false); }, 20000);
    window.addEventListener("focus", onFocus);
  }
  return { open, close };
})();
