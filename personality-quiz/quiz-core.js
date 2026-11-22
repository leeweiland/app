// Shared Training Personality quiz logic: the five 16Personalities-style
// trait scales, the 7-point answer scale, and scoring. Used by the quiz
// (index.html), the results page and both admin question editors.
//
// Question format in config.json:
//   { text: "...", dim: "EI" | "SN" | "TF" | "JP" | "AT", agree: <letter> }
// `agree` is the pole that agreeing with the statement points to. Keep each
// trait balanced (same number of questions keyed to each pole) or results
// drift toward one side -- the admin editor shows the balance.
(function (global) {
  const DIMENSIONS = [
    { key: 'EI', name: 'Mind',     a: 'E', b: 'I', aName: 'Extraverted', bName: 'Introverted' },
    { key: 'SN', name: 'Energy',   a: 'S', b: 'N', aName: 'Observant',   bName: 'Intuitive' },
    { key: 'TF', name: 'Nature',   a: 'T', b: 'F', aName: 'Thinking',    bName: 'Feeling' },
    { key: 'JP', name: 'Tactics',  a: 'J', b: 'P', aName: 'Judging',     bName: 'Prospecting' },
    { key: 'AT', name: 'Identity', a: 'A', b: 'T', aName: 'Assertive',   bName: 'Turbulent' },
  ];

  // Strongest agree first, like 16Personalities' 7-circle scale.
  const SCALE = [
    { label: 'Strongly agree', value: 3 },
    { label: 'Agree', value: 2 },
    { label: 'Slightly agree', value: 1 },
    { label: 'Neutral', value: 0 },
    { label: 'Slightly disagree', value: -1 },
    { label: 'Disagree', value: -2 },
    { label: 'Strongly disagree', value: -3 },
  ];

  function isValidQuestion(q) {
    const d = DIMENSIONS.find(x => x.key === q?.dim);
    return !!(d && (q.agree === d.a || q.agree === d.b) && typeof q.text === 'string');
  }

  // answers[i] is a SCALE value (-3..3) for questions[i].
  // Returns { mbti: "INTJ", identity: "A", code: "INTJ-A",
  //           traits: { EI: 38, ... } }  -- traits = % toward the FIRST letter.
  function score(questions, answers) {
    const sums = {}, counts = {}, strongest = {};
    DIMENSIONS.forEach(d => { sums[d.key] = 0; counts[d.key] = 0; strongest[d.key] = 0; });
    questions.forEach((q, i) => {
      if (!isValidQuestion(q)) return;
      const v = Number(answers[i]);
      if (!Number.isFinite(v)) return;
      const d = DIMENSIONS.find(x => x.key === q.dim);
      const signed = q.agree === d.a ? v : -v; // + = toward first letter
      sums[d.key] += signed;
      counts[d.key] += 1;
      if (Math.abs(signed) > Math.abs(strongest[d.key])) strongest[d.key] = signed;
    });
    const traits = {}, letters = {};
    DIMENSIONS.forEach(d => {
      const n = counts[d.key];
      const pct = n ? 50 + (50 * sums[d.key]) / (3 * n) : 50;
      traits[d.key] = Math.round(pct);
      // Exact tie: go with the single strongest answer on that scale.
      const lean = sums[d.key] !== 0 ? sums[d.key] : strongest[d.key];
      letters[d.key] = lean >= 0 ? d.a : d.b;
    });
    const mbti = letters.EI + letters.SN + letters.TF + letters.JP;
    return { mbti, identity: letters.AT, code: mbti + '-' + letters.AT, traits };
  }

  // Per-trait balance for the admin editors: { EI: { E: 4, I: 4 }, ... }
  function balance(questions) {
    const out = {};
    DIMENSIONS.forEach(d => { out[d.key] = { [d.a]: 0, [d.b]: 0 }; });
    (questions || []).forEach(q => { if (isValidQuestion(q)) out[q.dim][q.agree] += 1; });
    return out;
  }

  global.PRAQuiz = { DIMENSIONS, SCALE, score, balance, isValidQuestion };
})(window);
