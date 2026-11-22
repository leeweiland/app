// Quiz question editor shared by admin-panel.html (Training Personality tab)
// and personality-quiz/admin.html. Needs quiz-core.js loaded first.
//   PRAQuizQuestionsEditor.render(containerEl, config, onChange)
// Edits config.questions in place and calls onChange() after every edit.
(function (global) {
  const CSS = `
  .pqe-balance { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 12px; }
  .pqe-chip { font-size:.72rem; padding:5px 9px; border-radius:6px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.04); color:#ddd; }
  .pqe-chip.ok { border-color:rgba(63,185,80,.55); }
  .pqe-chip.off { border-color:rgba(248,81,73,.7); color:#ffb3ad; }
  .pqe-help { font-size:.75rem; color:#8b949e; line-height:1.45; margin:0 0 12px; }
  .pqe-row { display:flex; gap:8px; align-items:center; padding:8px 0; border-top:1px solid rgba(255,255,255,.06); flex-wrap:wrap; }
  .pqe-num { width:24px; flex-shrink:0; font-size:.75rem; color:#8b949e; text-align:right; }
  .pqe-text { flex:1 1 320px; min-width:0; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.14); border-radius:8px; color:#fff; padding:7px 9px; font:inherit; font-size:.82rem; }
  .pqe-sel { background:#0d1117; border:1px solid rgba(255,255,255,.14); border-radius:8px; color:#fff; padding:6px 8px; font:inherit; font-size:.78rem; }
  .pqe-btn { background:transparent; border:1px solid rgba(255,255,255,.14); border-radius:6px; color:#aaa; padding:5px 8px; cursor:pointer; font-size:.72rem; }
  .pqe-btn:hover { color:#fff; border-color:rgba(0,155,255,.6); }
  .pqe-del:hover { color:#f85149; border-color:rgba(248,81,73,.6); }
  .pqe-add { margin-top:10px; border-style:dashed; padding:8px 14px; }`;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function render(container, config, onChange) {
    if (!document.getElementById('pqe-style')) {
      const st = document.createElement('style'); st.id = 'pqe-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    const Q = PRAQuiz;
    if (!Array.isArray(config.questions)) config.questions = [];
    const qs = config.questions;
    const changed = () => { onChange && onChange(); drawBalance(); };

    container.innerHTML = `
      <p class="pqe-help">Scored like 16Personalities: 7-point agree/disagree, five traits, result = the 4-letter type plus Assertive/Turbulent.
      For accurate results keep every trait balanced: the same number of questions where agreeing points to each letter (green below).</p>
      <div class="pqe-balance"></div>
      <div class="pqe-list"></div>
      <button type="button" class="pqe-btn pqe-add">+ Add Question</button>`;
    const balEl = container.querySelector('.pqe-balance');
    const list = container.querySelector('.pqe-list');

    function drawBalance() {
      const b = Q.balance(qs);
      balEl.innerHTML = `<span class="pqe-chip">${qs.length} questions</span>` + Q.DIMENSIONS.map(d => {
        const na = b[d.key][d.a], nb = b[d.key][d.b];
        const ok = na === nb && na > 0;
        return `<span class="pqe-chip ${ok ? 'ok' : 'off'}" title="${ok ? 'Balanced' : 'Unbalanced: results will lean toward the side with more questions'}">${d.name}: ${na} ${d.a} · ${nb} ${d.b}</span>`;
      }).join('');
    }

    function agreeOptions(dimKey, current) {
      const d = Q.DIMENSIONS.find(x => x.key === dimKey) || Q.DIMENSIONS[0];
      return [[d.a, d.aName], [d.b, d.bName]].map(([l, n]) => `<option value="${l}" ${l === current ? 'selected' : ''}>Agree = ${n} (${l})</option>`).join('');
    }

    function drawList() {
      list.innerHTML = '';
      qs.forEach((q, i) => {
        if (!Q.DIMENSIONS.some(d => d.key === q.dim)) { q.dim = 'EI'; }
        const d = Q.DIMENSIONS.find(x => x.key === q.dim);
        if (q.agree !== d.a && q.agree !== d.b) q.agree = d.a;
        const row = document.createElement('div');
        row.className = 'pqe-row';
        row.innerHTML = `
          <span class="pqe-num">${i + 1}.</span>
          <input type="text" class="pqe-text" value="${esc(q.text)}" placeholder="Statement the person agrees or disagrees with">
          <select class="pqe-sel pqe-dim">${Q.DIMENSIONS.map(x => `<option value="${x.key}" ${x.key === q.dim ? 'selected' : ''}>${x.name} (${x.a}/${x.b})</option>`).join('')}</select>
          <select class="pqe-sel pqe-agree">${agreeOptions(q.dim, q.agree)}</select>
          <button type="button" class="pqe-btn pqe-up" title="Move up">↑</button>
          <button type="button" class="pqe-btn pqe-down" title="Move down">↓</button>
          <button type="button" class="pqe-btn pqe-del">Remove</button>`;
        row.querySelector('.pqe-text').addEventListener('input', e => { q.text = e.target.value; changed(); });
        row.querySelector('.pqe-dim').addEventListener('change', e => {
          q.dim = e.target.value;
          const nd = Q.DIMENSIONS.find(x => x.key === q.dim);
          q.agree = nd.a;
          row.querySelector('.pqe-agree').innerHTML = agreeOptions(q.dim, q.agree);
          changed();
        });
        row.querySelector('.pqe-agree').addEventListener('change', e => { q.agree = e.target.value; changed(); });
        row.querySelector('.pqe-up').addEventListener('click', () => { if (i > 0) { [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; drawList(); changed(); } });
        row.querySelector('.pqe-down').addEventListener('click', () => { if (i < qs.length - 1) { [qs[i + 1], qs[i]] = [qs[i], qs[i + 1]]; drawList(); changed(); } });
        row.querySelector('.pqe-del').addEventListener('click', () => {
          if (!confirm('Remove question ' + (i + 1) + '?')) return;
          qs.splice(i, 1); drawList(); changed();
        });
        list.appendChild(row);
      });
    }

    container.querySelector('.pqe-add').addEventListener('click', () => {
      qs.push({ text: '', dim: 'EI', agree: 'E' });
      drawList(); changed();
      const inputs = list.querySelectorAll('.pqe-text');
      inputs[inputs.length - 1]?.focus();
    });

    drawList();
    drawBalance();
  }

  global.PRAQuizQuestionsEditor = { render };
})(window);
