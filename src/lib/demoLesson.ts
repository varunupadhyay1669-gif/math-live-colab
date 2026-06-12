/**
 * Built-in demo lesson — "Equivalent Fractions Lab".
 *
 * Purpose: a brand-new teacher lands on the surface picker with no HTML file
 * on hand. One click loads this and the whole product is demoable: live
 * mirroring, control handoff, step lock (data-step markup), pings, late-join
 * replay — without ever leaving the app.
 *
 * Sync-friendliness rules this file follows (and demonstrates):
 *  - ALL visible state lives in the DOM (textContent / styles set from JS),
 *    so server snapshots capture it and late joiners boot mid-state.
 *  - Stable ids on every interactive element → event replay targets reliably.
 *  - No canvas, no external resources, no network, inline everything.
 *  - data-step sections (1-3) so the teacher can demo Step Lock.
 *  - Big typography; works at phone width.
 */
export const DEMO_LESSON_NAME = 'Demo — Equivalent Fractions Lab';

export const DEMO_LESSON_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Equivalent Fractions Lab</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #FAFBFF;
    color: #0F172A;
    padding: 28px 20px 60px;
    max-width: 860px;
    margin: 0 auto;
  }
  h1 { font-size: 26px; letter-spacing: -0.02em; margin-bottom: 4px; }
  .sub { color: #64748B; font-size: 14px; margin-bottom: 26px; }
  section {
    background: #fff; border: 1px solid #E2E8F0; border-radius: 16px;
    padding: 22px; margin-bottom: 18px; box-shadow: 0 8px 24px -20px rgba(15,23,42,.35);
  }
  .step-tag {
    display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .08em;
    color: #6366F1; background: #EEF2FF; border-radius: 999px; padding: 3px 10px; margin-bottom: 10px;
  }
  h2 { font-size: 18px; margin-bottom: 14px; }
  .frac-row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .frac {
    font-size: 44px; font-weight: 800; text-align: center; line-height: 1.05;
    min-width: 86px; font-variant-numeric: tabular-nums;
  }
  .frac .bar { border-top: 4px solid #0F172A; margin: 4px 8px; }
  .controls { display: flex; flex-direction: column; gap: 8px; }
  .ctl { display: flex; align-items: center; gap: 8px; }
  .ctl span { font-size: 12px; font-weight: 700; color: #64748B; width: 92px; }
  button {
    font: inherit; font-weight: 800; font-size: 18px; width: 42px; height: 42px;
    border-radius: 12px; border: 1px solid #C7D2FE; background: #EEF2FF; color: #4338CA;
    cursor: pointer; transition: transform .1s;
  }
  button:active { transform: scale(.94); }
  .bars { flex: 1 1 260px; display: flex; flex-direction: column; gap: 10px; min-width: 220px; }
  .bar-track { display: flex; gap: 3px; height: 44px; }
  .cell { flex: 1; border-radius: 8px; background: #E2E8F0; transition: background .25s; }
  .cell.fill { background: #6366F1; }
  .bar-label { font-size: 12px; font-weight: 700; color: #64748B; }
  .wide { width: auto; padding: 0 18px; font-size: 15px; height: 44px; }
  .good { background: #D1FAE5; border-color: #6EE7B7; color: #047857; }
  .verdict { font-size: 16px; font-weight: 800; margin-top: 12px; min-height: 24px; }
  .verdict.yes { color: #059669; }
  .verdict.no { color: #E11D48; }
  .win {
    font-size: 20px; font-weight: 800; color: #059669; margin-top: 12px; min-height: 28px;
  }
  .hint { font-size: 13px; color: #94A3B8; margin-top: 10px; }
</style>
</head>
<body>
  <h1>Equivalent Fractions Lab</h1>
  <p class="sub">Build fractions, see them as bars, and hunt for equivalents. (Teacher tip: Alt+click anything to ping it.)</p>

  <section data-step="1">
    <span class="step-tag">STEP 1</span>
    <h2>Build a fraction</h2>
    <div class="frac-row">
      <div class="frac">
        <div id="num1">1</div>
        <div class="bar"></div>
        <div id="den1">2</div>
      </div>
      <div class="controls">
        <div class="ctl"><span>Numerator</span>
          <button id="num1-down">−</button><button id="num1-up">+</button>
        </div>
        <div class="ctl"><span>Denominator</span>
          <button id="den1-down">−</button><button id="den1-up">+</button>
        </div>
      </div>
      <div class="bars">
        <div class="bar-label">This is what it looks like:</div>
        <div class="bar-track" id="bar1"></div>
      </div>
    </div>
  </section>

  <section data-step="2">
    <span class="step-tag">STEP 2</span>
    <h2>Compare with a second fraction</h2>
    <div class="frac-row">
      <div class="frac">
        <div id="num2">2</div>
        <div class="bar"></div>
        <div id="den2">4</div>
      </div>
      <div class="controls">
        <div class="ctl"><span>Numerator</span>
          <button id="num2-down">−</button><button id="num2-up">+</button>
        </div>
        <div class="ctl"><span>Denominator</span>
          <button id="den2-down">−</button><button id="den2-up">+</button>
        </div>
      </div>
      <div class="bars">
        <div class="bar-label">Second fraction:</div>
        <div class="bar-track" id="bar2"></div>
      </div>
    </div>
    <button class="wide" id="check-eq" style="margin-top:16px">Are they equivalent?</button>
    <div class="verdict" id="verdict"></div>
  </section>

  <section data-step="3">
    <span class="step-tag">STEP 3</span>
    <h2>Challenge: find THREE different fractions equivalent to the first one</h2>
    <p class="hint">Change the second fraction and press Check each time you think you have one. Same value, different numbers!</p>
    <button class="wide good" id="challenge-check" style="margin-top:14px">Check this one</button>
    <div class="win" id="challenge-progress">Found: 0 / 3</div>
    <div class="win" id="challenge-win"></div>
  </section>

<script>
(function () {
  // All state readable from the DOM (ids num1/den1/num2/den2, counters in
  // textContent) — that is what makes snapshots and late-join replay exact.
  function get(id) { return document.getElementById(id); }
  function val(id) { return parseInt(get(id).textContent, 10); }
  function setVal(id, v) { get(id).textContent = String(v); }

  function renderBar(barId, num, den) {
    var track = get(barId);
    track.innerHTML = '';
    for (var i = 0; i < den; i++) {
      var c = document.createElement('div');
      c.className = 'cell' + (i < num ? ' fill' : '');
      track.appendChild(c);
    }
  }
  function renderAll() {
    renderBar('bar1', val('num1'), val('den1'));
    renderBar('bar2', val('num2'), val('den2'));
  }

  function bump(id, delta, lo, hi) {
    var v = Math.min(hi, Math.max(lo, val(id) + delta));
    setVal(id, v);
    // keep numerator <= denominator for honest bars
    var which = id.indexOf('1') >= 0 ? '1' : '2';
    if (val('num' + which) > val('den' + which)) setVal('num' + which, val('den' + which));
    renderAll();
  }

  [['num1', 1], ['den1', 1], ['num2', 2], ['den2', 2]].forEach(function (pair) {
    var id = pair[0];
    var lo = id.indexOf('den') === 0 ? 1 : 0;
    get(id + '-up').addEventListener('click', function () { bump(id, +1, lo, 12); });
    get(id + '-down').addEventListener('click', function () { bump(id, -1, lo, 12); });
  });

  function equivalent() {
    return val('num1') * val('den2') === val('num2') * val('den1');
  }

  get('check-eq').addEventListener('click', function () {
    var v = get('verdict');
    if (equivalent()) {
      v.textContent = '✓ Yes! ' + val('num1') + '/' + val('den1') + ' and ' + val('num2') + '/' + val('den2') + ' are the same amount.';
      v.className = 'verdict yes';
    } else {
      v.textContent = '✗ Not quite — look at how much of each bar is filled.';
      v.className = 'verdict no';
    }
  });

  // Challenge: collect 3 DISTINCT equivalents (state kept in the DOM via a
  // data attribute + visible counter, so it survives snapshot + replay).
  get('challenge-check').addEventListener('click', function () {
    var progress = get('challenge-progress');
    var found = progress.getAttribute('data-found') || '';
    var key = val('num2') + '/' + val('den2');
    var isSelf = val('num2') === val('num1') && val('den2') === val('den1');
    if (!equivalent() || isSelf) {
      get('challenge-win').textContent = isSelf ? 'Different numbers please — not the same fraction!' : 'That one is not equivalent. Keep hunting!';
      return;
    }
    if (found.split('|').indexOf(key) >= 0) {
      get('challenge-win').textContent = 'Already counted ' + key + ' — find a NEW one!';
      return;
    }
    found = found ? found + '|' + key : key;
    progress.setAttribute('data-found', found);
    var n = found.split('|').length;
    progress.textContent = 'Found: ' + n + ' / 3';
    get('challenge-win').textContent = n >= 3
      ? '🏆 Fraction master! You found three equivalents.'
      : 'Nice — ' + key + ' counts! ' + (3 - n) + ' to go.';
  });

  renderAll();
})();
</script>
</body>
</html>`;
