/* Cipher Shift interface: screens, the looping intercept stream, decode input and persistence. */
(function () {
  'use strict';
  const L = window.CipherLogic;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['welcome', 'intercept', 'decode', 'paused', 'result'];
  const PHASE_LABEL = { welcome: 'Ready to connect', intercept: 'Intercept / active', decode: 'Decode / active' };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const compactLayout = matchMedia('(max-width: 760px), (max-height: 520px) and (orientation: landscape)');
  const INPUT_GUARD_MS = 500; // ignore repeat taps on the moving stream
  const SUBMIT_GUARD_MS = 250; // a rejected key always leaves empty slots, so this only absorbs key repeat
  const CAPTURE_HOLD_MS = 420;
  const REGEN_GUARD_MS = 200;

  let state;
  let logs = [];
  // The stream is moved by requestAnimationFrame so its position survives captures, mistakes and pauses.
  const motion = { offset: 0, period: 0, last: 0, raf: 0, hold: false };

  function now() {
    return performance.now();
  }
  function show(id) {
    SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
  }
  function showCurrent() {
    show(state.paused ? 'paused' : state.phase);
    $('phase').textContent = state.paused ? 'Connection paused' : PHASE_LABEL[state.phase] ?? $('phase').textContent;
  }
  function log(text) {
    logs = [text, ...logs].slice(0, 4);
    $('log').replaceChildren(...logs.map((t) => {
      const d = document.createElement('div');
      d.innerHTML = '<span>›</span> ';
      d.append(t);
      return d;
    }));
  }
  // `content` is a string or an array of strings and nodes (e.g. glyph icons).
  function hint(id, content, warn = false) {
    $(id).replaceChildren(...[].concat(content));
    $(id).classList.toggle('warn', warn);
  }

  // Glyphs keep their Unicode identity in game state but are drawn from the SVG sprite in index.html.
  const GLYPH_ART = { '△': ['tri', 'triangle'], '○': ['ring', 'ring'], '◇': ['diamond', 'diamond'], '⊕': ['node', 'node'], '≋': ['wave', 'wave'], '⌁': ['bolt', 'bolt'] };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function glyphName(g) {
    return GLYPH_ART[g]?.[1] ?? g;
  }
  function glyphIcon(g) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'glyph');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#g-' + GLYPH_ART[g][0]);
    svg.append(use);
    return svg;
  }
  // A glyph icon followed by its name for screen readers.
  function glyphLabel(g) {
    const name = document.createElement('span');
    name.className = 'sr-only';
    name.textContent = glyphName(g);
    return [glyphIcon(g), name];
  }
  // Clue text starts with the glyph character; swap it for the icon. With `decrypt`, the text resolves
  // out of cipher noise; screen readers get the final text at once from a hidden copy.
  function clueNodes(c, decrypt = false) {
    const text = L.clueText(c).slice(c.glyph.length);
    if (!decrypt || reducedMotion.matches) return [...glyphLabel(c.glyph), text];
    const shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    const spoken = document.createElement('span');
    spoken.className = 'sr-only';
    spoken.textContent = text;
    decryptText(shown, text);
    return [...glyphLabel(c.glyph), shown, spoken];
  }
  const NOISE = '░▒▓<>/\\|=+*#%01';
  function decryptText(el, text, ms = 520) {
    const term = state;
    const t0 = now();
    el.classList.add('decrypting');
    const step = () => {
      if (state !== term) return;
      const p = Math.min(1, (now() - t0) / ms);
      const done = Math.floor(text.length * p);
      el.textContent = text.slice(0, done) + [...text.slice(done)].map((ch) => (ch === ' ' ? ' ' : NOISE[(Math.random() * NOISE.length) | 0])).join('');
      if (p < 1) requestAnimationFrame(step);
      else el.classList.remove('decrypting');
    };
    step();
  }

  // Replays a one-shot CSS animation class.
  function pulse(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function setTrace(value) {
    state.trace = Math.max(0, Math.min(L.TRACE.lockdown, value));
    const pct = state.trace + '%';
    $('traceNumber').textContent = pct;
    $('hudTrace').textContent = pct;
    $('traceBar').style.width = pct;
    $('hudBar').style.width = pct;
    $('traceMeter').setAttribute('aria-valuenow', state.trace);
    // Escalation: the meter pulses from 50%, the console tints at 75% and alarms at 90%.
    document.body.dataset.trace = state.trace >= 90 ? 'critical' : state.trace >= 75 ? 'high' : state.trace >= 50 ? 'warn' : '';
  }
  // Returns true when the added trace triggered a lockdown.
  function addTrace(amount, reason) {
    setTrace(state.trace + amount);
    for (const el of [$('traceNumber'), $('hudTrace')]) pulse(el, 'hot');
    pulse($('console'), 'hit');
    if (state.trace >= L.TRACE.lockdown) {
      finish(false, reason || 'Security isolated the connection.');
      return true;
    }
    return false;
  }

  function reset() {
    stopMotion();
    clearTimeout(state?.timer);
    clearInterval(state?.revealTimer);
    const mode = $('difficulty').value;
    const cfg = L.DIFFICULTY[mode] ?? L.DIFFICULTY.standard;
    state = { mode, cfg, n: cfg.n, trace: 0, captures: 0, attempt: 0, guess: [], history: [], phase: 'welcome', paused: false, selected: 0, lockUntil: 0, timer: 0 };
    state.secret = L.makeSecret(state.n);
    state.clues = L.makeClues(state.secret);
    logs = [];
    setTrace(0);
    renderClues();
    $('packets').replaceChildren();
    motion.offset = 0;
    motion.hold = false;
    $('s1').classList.add('active');
    $('s2').classList.remove('active');
    document.body.classList.remove('playing');
    $('start').disabled = false;
    showCurrent();
    log('New ' + cfg.label + ' terminal acquired.');
  }

  function start() {
    if (state.phase !== 'welcome') return;
    state.phase = 'intercept';
    document.body.classList.add('playing');
    renderCaptures();
    hint('interceptHint', 'Tap the block that matches the reference exactly. Missed it? Every block loops back.');
    newStream();
    showCurrent();
    layoutCopies();
    startMotion();
    focusConsole();
    log('Uplink established. Capture 3 fragments.');
  }

  function focusConsole() {
    const r = $('console').getBoundingClientRect();
    if (!compactLayout.matches && r.top >= 0 && r.bottom <= innerHeight) return;
    $('console').scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  /* ---------- Intercept stream ---------- */

  function renderCaptures() {
    $('captured').textContent = state.captures + ' / ' + L.CAPTURES_NEEDED + ' captured';
    $('dots').replaceChildren(...Array.from({ length: L.CAPTURES_NEEDED }, (_, i) => {
      const d = document.createElement('i');
      if (i < state.captures) d.className = i === state.captures - 1 ? 'on pop' : 'on';
      return d;
    }));
  }

  // Terminal-style code: one row per line with a numbered gutter and token colouring.
  const TOKEN_RE = /(\s+)|\b(if|end|ret|jmp|ack)\b|([a-z]+)(?=\()|(0x[0-9A-F]+|\b[0-9A-F]{2}\b)|([=<>()])|([a-z]+)|(\S)/g;
  const TOKEN_CLASS = [null, 'kw', 'fn', 'num', 'op', 'id', null];
  function renderCode(el, code) {
    el.replaceChildren(...code.split('\n').map((line, i) => {
      const row = document.createElement('span');
      row.className = 'ln';
      row.dataset.n = i + 1;
      for (const m of line.matchAll(TOKEN_RE)) {
        const kind = TOKEN_CLASS[m.slice(1).findIndex((x) => x !== undefined)];
        if (!kind) {
          row.append(m[0]);
          continue;
        }
        const s = document.createElement('span');
        s.className = kind;
        s.textContent = m[0];
        row.append(s);
      }
      return row;
    }));
  }
  // Diff-style marks: '+' rows on a capture, '−' rows where a rejected block differs from the reference.
  function markLines(id, mode, ms) {
    const ref = state.stream.target.split('\n');
    const code = state.stream.blocks[id].code.split('\n');
    const rows = $('packets').querySelectorAll('.packet[data-id="' + id + '"] .ln');
    rows.forEach((row, k) => row.classList.toggle(mode, mode === 'add' || code[k % 4] !== ref[k % 4]));
    if (ms) setTimeout(() => rows.forEach((row) => row.classList.remove(mode)), ms);
  }

  // Decorative 4-hex signal ID for the reference readout (a simple string hash; not a game rule).
  function signature(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return ((h >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  }

  function newStream() {
    const keyboardFocus = motion.hold ? document.activeElement?.dataset?.id : undefined;
    state.stream = L.makeStream(state.mode);
    renderCode($('target'), state.stream.target);
    $('refsig').textContent = signature(state.stream.target);
    renderStream();
    // Captures already hold input for CAPTURE_HOLD_MS, so a short guard covers taps landing on fresh blocks.
    state.lockUntil = now() + REGEN_GUARD_MS;
    if (keyboardFocus !== undefined) $('packets').querySelector('.packet[data-id="' + keyboardFocus + '"]')?.focus({ preventScroll: true });
  }

  function buildGroup(copy) {
    const group = document.createElement('div');
    group.className = 'streamgroup';
    for (const block of state.stream.blocks) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'packet' + (block.hazard ? ' hazard' : '');
      b.dataset.id = block.id;
      const label = document.createElement('small');
      label.textContent = block.hazard ? '▲ PROBE' : 'BLK.' + String(block.id + 1).padStart(2, '0');
      const code = document.createElement('code');
      renderCode(code, block.code);
      b.append(label, code);
      if (copy === 0) {
        b.setAttribute('aria-label', (block.hazard ? 'Security probe ' : 'Code block ') + (block.id + 1) + ': ' + block.code.replace(/\n\s*/g, '; '));
      } else {
        // Visual repeats for the seamless loop: clickable, but hidden from assistive tech and the tab order.
        b.tabIndex = -1;
        b.setAttribute('aria-hidden', 'true');
      }
      group.append(b);
    }
    return group;
  }

  function renderStream() {
    const manual = reducedMotion.matches;
    $('stream').classList.toggle('manual', manual);
    $('packets').replaceChildren(buildGroup(0));
    groupObserver?.disconnect();
    groupObserver?.observe($('packets').firstElementChild);
    groupObserver?.observe($('stream'));
    if (manual) {
      $('packets').style.transform = '';
      motion.period = 0;
    } else {
      layoutCopies();
    }
  }

  // Enough identical copies to cover the viewport plus one, so wrapping the offset is invisible.
  function layoutCopies() {
    if (state.phase !== 'intercept' || reducedMotion.matches) return;
    const track = $('packets');
    const first = track.firstElementChild;
    if (!first || !first.offsetHeight) return;
    motion.period = first.offsetHeight;
    const need = Math.ceil($('stream').clientHeight / motion.period) + 1;
    while (track.children.length < need) track.append(buildGroup(track.children.length));
    while (track.children.length > need) track.lastElementChild.remove();
    motion.offset %= motion.period;
    applyOffset();
  }
  const groupObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layoutCopies()) : null;

  function applyOffset() {
    $('packets').style.transform = 'translate3d(0,' + (-motion.offset).toFixed(2) + 'px,0)';
  }
  function moving() {
    return state.phase === 'intercept' && !state.paused && !motion.hold && !reducedMotion.matches && motion.period > 0;
  }
  function tick(t) {
    // Clamp frame gaps (background tabs, slow frames) so the stream never leaps.
    const dt = Math.min(0.05, Math.max(0, (t - motion.last) / 1000));
    motion.last = t;
    if (moving()) {
      motion.offset = (motion.offset + state.cfg.speed * dt) % motion.period;
      applyOffset();
    }
    motion.raf = requestAnimationFrame(tick);
  }
  function startMotion() {
    if (motion.raf || reducedMotion.matches) return;
    motion.last = now();
    motion.raf = requestAnimationFrame(tick);
  }
  function stopMotion() {
    cancelAnimationFrame(motion.raf);
    motion.raf = 0;
  }

  function flash(id, cls, ms = 600) {
    const els = $('packets').querySelectorAll('.packet[data-id="' + id + '"]');
    els.forEach((el) => {
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    });
    setTimeout(() => els.forEach((el) => el.classList.remove(cls)), ms);
  }

  function select(id) {
    if (state.phase !== 'intercept' || state.paused) return;
    const t = now();
    if (t < state.lockUntil) return;
    const block = state.stream.blocks[id];
    if (!block) return;
    if (block.correct) return capture(id);
    state.lockUntil = t + INPUT_GUARD_MS;
    flash(id, 'rejected');
    markLines(id, 'del', 1800);
    const cost = block.hazard ? L.TRACE.probe : L.TRACE.miss;
    if (addTrace(cost, block.hazard ? 'A security probe traced your signal.' : 'Too many invalid fragments. Security isolated the connection.')) return;
    hint('interceptHint', block.hazard ? 'Security probe hit. Trace +' + cost + '%. The reference is unchanged.' : 'Mismatch. Trace +' + cost + '%. Compare every line; the reference is unchanged.', true);
    log(block.hazard ? 'Probe detected your signal.' : 'Invalid fragment rejected.');
  }

  function capture(id) {
    state.captures++;
    state.lockUntil = Infinity;
    $('packets').querySelectorAll('.packet[data-id="' + id + '"]').forEach((el) => el.classList.add('captured'));
    markLines(id, 'add');
    renderCaptures();
    renderClues(true);
    hint('interceptHint', ['Fragment captured. Clue ' + state.captures + ': ', ...clueNodes(state.clues[state.captures - 1], true)]);
    log('Fragment ' + state.captures + ' captured. Clue decrypted.');
    const term = state;
    state.timer = setTimeout(() => {
      if (state !== term || state.phase !== 'intercept') return;
      if (state.captures >= L.CAPTURES_NEEDED) beginDecode();
      else newStream();
    }, CAPTURE_HOLD_MS);
  }

  function refresh() {
    if (state.phase !== 'intercept' || state.paused || now() < state.lockUntil) return;
    if (addTrace(L.TRACE.refresh)) return;
    newStream();
    hint('interceptHint', 'Stream refreshed with a new reference. Trace +' + L.TRACE.refresh + '%.');
    log('Stream refreshed.');
  }

  // `decryptNewest` animates the clue that was just captured.
  function renderClues(decryptNewest = false) {
    const shown = state.clues.slice(0, state.captures);
    const items = () => shown.map((c, i) => {
      const d = document.createElement('div');
      d.className = 'clue';
      const n = document.createElement('b');
      n.textContent = String(i + 1).padStart(2, '0');
      d.append(n, ...clueNodes(c, decryptNewest && i === shown.length - 1));
      return d;
    });
    const empty = () => {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'Capture fragments to reveal clues.';
      return d;
    };
    $('clues').replaceChildren(...(shown.length ? items() : [empty()]));
    $('decodeClues').replaceChildren(...(shown.length ? items() : [empty()]));
  }

  /* ---------- Decode ---------- */

  function beginDecode() {
    state.phase = 'decode';
    stopMotion();
    motion.hold = false;
    $('stream').classList.remove('held');
    $('s1').classList.remove('active');
    $('s2').classList.add('active');
    state.guess = Array(state.n).fill(null);
    state.selected = 0;
    state.lockUntil = 0;
    buildDecode();
    renderDecode();
    hint('decodeHint', 'Choose a slot, then tap a glyph. Use your intercepted clues.');
    showCurrent();
    focusConsole();
    powerOnDecode();
    log('Cipher layer exposed. Five submissions.');
  }

  // Handoff from intercept: a band sweeps the panel while the lock rows and keys power on in sequence.
  // Purely visual (pointer-events: none) so input is never blocked; skipped with reduced motion.
  function powerOnDecode() {
    if (reducedMotion.matches) return;
    const term = state;
    const band = document.createElement('div');
    band.className = 'layerflash';
    band.setAttribute('aria-hidden', 'true');
    band.textContent = 'CIPHER LAYER EXPOSED';
    $('console').append(band);
    $('decode').classList.add('entering');
    setTimeout(() => {
      band.remove();
      if (state === term) $('decode').classList.remove('entering');
    }, 1300);
  }

  // Controls are built once per terminal and updated in place so keyboard focus is never lost.
  function buildDecode() {
    $('history').replaceChildren();
    $('entry').replaceChildren(...state.guess.map((_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.dataset.slot = i;
      return b;
    }));
    $('keyboard').replaceChildren(...L.GLYPHS.map((g, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'key';
      b.dataset.glyph = g;
      const n = document.createElement('small');
      n.textContent = i + 1;
      const led = document.createElement('i');
      led.className = 'led';
      b.append(n, glyphIcon(g), led);
      b.style.setProperty('--i', i);
      return b;
    }));
  }
  function led() {
    const i = document.createElement('i');
    i.className = 'led';
    return i;
  }
  function rowNumber(i) {
    return String(i + 1).padStart(2, '0');
  }

  function knownStatus(g) {
    let best = '';
    for (const row of state.history) {
      row.guess.forEach((x, i) => {
        if (x !== g) return;
        const m = row.marks[i];
        if (m === 'exact' || (m === 'present' && best !== 'exact') || (m === 'absent' && !best)) best = m;
      });
    }
    return best;
  }

  function renderDecode() {
    const left = L.MAX_SUBMISSIONS - state.attempt;
    $('attempts').textContent = left + (left === 1 ? ' try left' : ' tries left');
    $('pips').replaceChildren(...Array.from({ length: L.MAX_SUBMISSIONS }, (_, i) => {
      const pip = document.createElement('i');
      if (i < left) pip.className = 'on';
      return pip;
    }));
    const labels = { exact: '✓', present: '↔', absent: '×' };
    const words = { exact: 'correct position', present: 'wrong position', absent: 'absent' };
    const rows = $('history');
    while (rows.children.length < state.history.length) {
      const r = state.history[rows.children.length];
      const row = document.createElement('div');
      row.className = 'row fresh'; // sockets settle and LEDs light one by one
      row.dataset.n = rowNumber(rows.children.length);
      row.setAttribute('role', 'img');
      row.setAttribute('aria-label', 'Submission ' + (rows.children.length + 1) + ': ' + r.guess.map((g, i) => glyphName(g) + ' ' + words[r.marks[i]]).join(', '));
      r.guess.forEach((g, i) => {
        const s = document.createElement('div');
        s.className = 'slot ' + r.marks[i];
        s.style.setProperty('--i', i);
        const mark = document.createElement('small');
        mark.textContent = labels[r.marks[i]];
        s.append(glyphIcon(g), mark, led());
        row.append(s);
      });
      rows.append(row);
    }
    // Unused attempts stay visible as dim rows below the live one.
    const live = state.phase === 'decode';
    $('entry').dataset.n = rowNumber(state.attempt);
    $('entry').classList.toggle('hidden', !live);
    const future = live ? L.MAX_SUBMISSIONS - state.attempt - 1 : 0;
    $('future').replaceChildren(...Array.from({ length: future }, (_, k) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.n = rowNumber(state.attempt + 1 + k);
      row.style.setProperty('--i', k + 1);
      for (let i = 0; i < state.n; i++) {
        const s = document.createElement('div');
        s.className = 'slot';
        row.append(s);
      }
      return row;
    }));
    [...$('entry').children].forEach((b, i) => {
      const g = state.guess[i];
      if (b.dataset.g !== (g ?? '')) {
        b.dataset.g = g ?? '';
        const socket = document.createElement('span');
        socket.className = 'socket';
        b.replaceChildren(g ? glyphIcon(g) : socket);
      }
      b.classList.toggle('selected', i === state.selected);
      b.setAttribute('aria-pressed', String(i === state.selected));
      b.setAttribute('aria-label', 'Slot ' + (i + 1) + (g ? ' ' + glyphName(g) : ' empty'));
    });
    [...$('keyboard').children].forEach((b, i) => {
      const status = knownStatus(b.dataset.glyph);
      b.className = 'key' + (status ? ' ' + status : '');
      b.setAttribute('aria-label', 'Glyph ' + (i + 1) + ' ' + glyphName(b.dataset.glyph) + (status ? ', ' + words[status] : ''));
    });
    $('submit').disabled = state.guess.includes(null);
  }

  function canDecode() {
    return state.phase === 'decode' && !state.paused;
  }

  function enter(g) {
    if (!canDecode()) return;
    const at = state.guess.indexOf(g);
    if (at >= 0 && at !== state.selected) {
      state.guess[at] = null;
      hint('decodeHint', ['Glyphs never repeat: ', ...glyphLabel(g), ' moved from slot ' + (at + 1) + ' to slot ' + (state.selected + 1) + '.']);
    }
    state.guess[state.selected] = g;
    for (let k = 1; k <= state.n; k++) {
      const i = (state.selected + k) % state.n;
      if (state.guess[i] === null) {
        state.selected = i;
        break;
      }
    }
    renderDecode();
  }

  function erase() {
    if (!canDecode()) return;
    if (state.guess[state.selected] === null && state.selected > 0) state.selected--;
    state.guess[state.selected] = null;
    renderDecode();
  }

  function selectSlot(i) {
    if (!canDecode()) return;
    state.selected = Math.max(0, Math.min(state.n - 1, i));
    renderDecode();
  }

  function submit() {
    if (!canDecode() || state.guess.includes(null)) return;
    const t = now();
    if (t < state.lockUntil) return;
    state.lockUntil = t + SUBMIT_GUARD_MS;
    const guess = [...state.guess];
    const marks = L.scoreGuess(state.secret, guess);
    state.attempt++;
    state.history.push({ guess, marks });
    if (marks.every((m) => m === 'exact')) {
      renderDecode();
      finish(true, 'Access key verified. Encrypted archive recovered.');
      return;
    }
    if (addTrace(state.cfg.submitTrace, 'Rejected keys pushed trace to 100%. Security isolated the connection.')) return;
    if (state.attempt >= L.MAX_SUBMISSIONS) {
      finish(false, 'Submission limit reached. The terminal locked you out.', 'limit');
      return;
    }
    const exact = marks.filter((m) => m === 'exact').length;
    log('Key rejected. ' + exact + ' of ' + state.n + ' positions verified.');
    state.guess = guess.map((g, i) => (marks[i] === 'exact' ? g : null));
    state.selected = Math.max(0, state.guess.indexOf(null));
    hint('decodeHint', 'Key rejected. Trace +' + state.cfg.submitTrace + '%. Correct positions carry forward.', true);
    renderDecode();
  }

  /* ---------- Pause, results ---------- */

  function pause() {
    if (state.paused || (state.phase !== 'intercept' && state.phase !== 'decode')) return;
    state.paused = true;
    stopMotion();
    showCurrent();
    $('resume').focus({ preventScroll: true });
    log('Connection paused.');
  }
  function resume() {
    if (!state.paused) return;
    state.paused = false;
    showCurrent();
    if (state.phase === 'intercept') {
      layoutCopies();
      startMotion();
    }
    log('Connection resumed.');
  }

  function storedWins(add) {
    try {
      const wins = Number(localStorage.getItem('cipherShiftWins') || 0) + add;
      if (add) localStorage.setItem('cipherShiftWins', wins);
      return wins;
    } catch {
      return null;
    }
  }

  // The key decrypts slot by slot: each socket cycles random glyphs before settling (instant with reduced motion).
  function revealKey(sockets, settledClass) {
    const term = state;
    const settle = (s, i) => {
      s.className = 'slot ' + settledClass;
      s.querySelector('use').setAttribute('href', '#g-' + GLYPH_ART[state.secret[i]][0]);
    };
    if (reducedMotion.matches) return sockets.forEach(settle);
    let tick = 0;
    clearInterval(state.revealTimer);
    state.revealTimer = setInterval(() => {
      if (state !== term) return;
      tick++;
      sockets.forEach((s, i) => {
        if (s.classList.contains(settledClass)) return;
        if (tick >= 5 + i * 3) settle(s, i);
        else s.querySelector('use').setAttribute('href', '#g-' + GLYPH_ART[L.GLYPHS[(tick + i * 2) % L.GLYPHS.length]][0]);
      });
      if (sockets.every((s) => s.classList.contains(settledClass))) clearInterval(state.revealTimer);
    }, 70);
  }

  // kind: 'win', 'trace' (trace hit 100%) or 'limit' (submissions used up).
  function finish(win, msg, kind = win ? 'win' : 'trace') {
    clearTimeout(state.timer);
    state.phase = 'result';
    state.paused = false;
    state.lockUntil = Infinity;
    stopMotion();
    const wins = storedWins(win ? 1 : 0);
    const copy = {
      win: ['TERMINAL COMPROMISED', 'You’re through.', 'Access granted'],
      trace: ['SECURITY LOCKDOWN', 'Signal traced.', 'Connection lost'],
      limit: ['TERMINAL LOCKED', 'Locked out.', 'Connection lost'],
    }[kind];
    const box = $('result');
    box.className = 'result ' + (win ? 'won' : 'lost');
    box.innerHTML = '<div class="eyebrow"></div><div class="emblemwrap"><svg class="emblem" aria-hidden="true" focusable="false"><use/></svg></div><h2></h2><p class="msg"></p>'
      + '<div class="keyreadout"><span class="label"></span><div class="sockets" role="img"></div></div>'
      + '<dl class="readout"><div><dt>TRACE</dt><dd class="trace"></dd></div><div><dt>SUBMISSIONS</dt><dd class="subs"></dd></div><div><dt>WINS HERE</dt><dd class="wins"></dd></div></dl>'
      + '<button class="primary" id="again">Connect to next terminal →</button>';
    box.querySelector('.eyebrow').textContent = copy[0];
    box.querySelector('.emblem use').setAttribute('href', win ? '#emblem-open' : '#emblem-sealed');
    box.querySelector('h2').textContent = copy[1];
    box.querySelector('.msg').textContent = msg;
    box.querySelector('.keyreadout .label').textContent = win ? 'ACCESS KEY · VERIFIED' : 'ACCESS KEY · REVEALED';
    const sockets = state.secret.map((g) => {
      const s = document.createElement('div');
      s.className = 'slot scrambling';
      s.append(glyphIcon(g), led());
      return s;
    });
    box.querySelector('.sockets').replaceChildren(...sockets);
    box.querySelector('.sockets').setAttribute('aria-label', 'Access key: ' + state.secret.map(glyphName).join(', '));
    box.querySelector('.trace').textContent = state.trace + '%';
    box.querySelector('.subs').textContent = state.attempt + ' / ' + L.MAX_SUBMISSIONS;
    box.querySelector('.wins').textContent = wins ?? '—';
    revealKey(sockets, win ? 'exact' : 'revealed');
    $('again').onclick = (e) => {
      e.currentTarget.disabled = true;
      reset();
      start();
    };
    $('phase').textContent = copy[2];
    show('result');
    $('again').focus({ preventScroll: true });
    log(win ? 'Archive recovered. Connection closed.' : 'Session terminated. Access key revealed.');
  }

  /* ---------- Wiring ---------- */

  $('start').onclick = (e) => {
    e.currentTarget.disabled = true;
    start();
  };
  $('restart').onclick = reset;
  $('difficulty').onchange = reset;
  $('refresh').onclick = refresh;
  $('submit').onclick = submit;
  $('erase').onclick = erase;
  $('resume').onclick = resume;
  document.querySelectorAll('.pause').forEach((b) => (b.onclick = pause));
  $('packets').addEventListener('click', (e) => {
    const b = e.target.closest('.packet');
    if (b) select(Number(b.dataset.id));
  });
  $('entry').addEventListener('click', (e) => {
    const b = e.target.closest('.slot');
    if (b) selectSlot(Number(b.dataset.slot));
  });
  $('keyboard').addEventListener('click', (e) => {
    const b = e.target.closest('.key');
    if (b) enter(b.dataset.glyph);
  });

  // Keyboard users: focusing a block holds the stream and brings that block into view.
  const stream = $('stream');
  stream.addEventListener('focusin', (e) => {
    const b = e.target.closest('.packet');
    if (!b || reducedMotion.matches) return;
    let visible = false;
    try {
      visible = b.matches(':focus-visible');
    } catch {
      visible = true;
    }
    if (!visible) return;
    motion.hold = true;
    stream.classList.add('held');
    const top = b.offsetTop;
    if (top < motion.offset + 4 || top + b.offsetHeight > motion.offset + stream.clientHeight - 4) {
      motion.offset = Math.max(0, top - 8); // the focused element is always in the first copy
      applyOffset();
    }
  });
  stream.addEventListener('focusout', (e) => {
    if (stream.contains(e.relatedTarget)) return;
    motion.hold = false;
    stream.classList.remove('held');
  });
  // Focus can scroll an overflow:hidden box; the transform owns the position, so undo it.
  stream.addEventListener('scroll', () => {
    if (!stream.classList.contains('manual')) stream.scrollTop = 0;
  });

  reducedMotion.addEventListener?.('change', () => {
    if (state.phase !== 'intercept') return;
    stopMotion();
    renderStream();
    if (!state.paused) startMotion();
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (state.paused) {
        e.preventDefault();
        resume();
      } else if (state.phase === 'intercept' || state.phase === 'decode') {
        e.preventDefault();
        pause();
      }
      return;
    }
    if (!canDecode()) return;
    if (e.key >= '1' && e.key <= String(L.GLYPHS.length)) {
      e.preventDefault();
      if (!e.repeat) enter(L.GLYPHS[Number(e.key) - 1]);
    } else if (e.key === 'Enter') {
      // Enter submits a complete key from the glyph pad or slots; other focused buttons act normally.
      const onPad = e.target.closest?.('#keyboard, #entry');
      if (e.target.closest?.('button') && !(onPad && !state.guess.includes(null))) return;
      e.preventDefault();
      if (!e.repeat) submit();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      erase();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target.closest?.('#keyboard')) return;
      e.preventDefault();
      selectSlot(state.selected + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  });

  reset();
  // Read-only hook for automated browser checks.
  window.CipherShiftDebug = { get state() { return state; }, motion };
})();
