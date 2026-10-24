/* Cipher Shift save codes: wins, grain setting and a round in progress, packed into a short text code that can be
   copied to another device. Pure functions (no DOM, no storage) so they can be tested in Node. */
(function (root) {
  'use strict';
  const L = root.CipherLogic || (typeof require === 'function' ? require('./logic.js') : null);

  const VERSION = 1;
  const PREFIX = 'CS' + VERSION + '-';
  const MODES = Object.keys(L.DIFFICULTY);
  const GRAINS = ['static', 'animated', 'off'];
  const PHASES = ['intercept', 'decode'];
  const KINDS = ['present', 'absent', 'exact'];
  const MAX_WINS = 1e6;

  // A mistyped or truncated code fails this 4-hex check instead of loading something else.
  function check(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return ((h >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  }
  const toB64 = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64 = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const glyphIndex = (g) => L.GLYPHS.indexOf(g);

  // save: { wins, grain, sound, music, cleared, round }. sound and music are 'on' or 'off' and cleared lists the levels
  // won (each null when a code predates it);
  // round is null or
  // { mode, phase, trace, captures, secret, clues, guesses, guess } (guesses: rejected submissions; guess: the entry row).
  function encode(save) {
    const data = { v: VERSION, w: save.wins, g: GRAINS.indexOf(save.grain) };
    if (save.sound) data.s = save.sound === 'on' ? 1 : 0;
    if (save.music) data.m = save.music === 'on' ? 1 : 0;
    if (save.cleared) data.c = save.cleared.reduce((bits, m) => bits | (1 << MODES.indexOf(m)), 0);
    const r = save.round;
    if (r) {
      data.r = [
        MODES.indexOf(r.mode),
        PHASES.indexOf(r.phase),
        r.trace,
        r.captures,
        r.secret.map(glyphIndex),
        r.clues.map((c) => [KINDS.indexOf(c.kind), glyphIndex(c.glyph), c.slot ?? -1]),
        r.guesses.map((row) => row.map(glyphIndex)),
        r.guess.map((g) => (g === null ? -1 : glyphIndex(g))),
      ];
    }
    const body = toB64(JSON.stringify(data));
    return PREFIX + body + '-' + check(body);
  }

  function fail(msg) {
    throw new Error(msg);
  }
  const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  function glyphs(list, n, allowEmpty = false) {
    if (!Array.isArray(list) || list.length !== n) fail('bad');
    const out = list.map((i) => (allowEmpty && i === -1 ? null : isInt(i, 0, L.GLYPHS.length - 1) ? L.GLYPHS[i] : fail('bad')));
    const used = out.filter((g) => g !== null);
    if (new Set(used).size !== used.length) fail('bad');
    return out;
  }

  // Accepts a bare code, a code with stray spaces or line breaks, or a whole link ending in #save=CODE.
  // Returns { wins, grain, sound, music, cleared, round } or throws an Error whose message can be shown to the player.
  function decode(input) {
    const text = String(input ?? '').trim();
    const code = (text.includes('#save=') ? decodeURIComponent(text.split('#save=')[1]) : text).replace(/\s+/g, '');
    if (!code) fail('Paste a save code first.');
    if (!code.startsWith(PREFIX)) fail(/^CS\d+-/.test(code) ? 'This save code is from a newer version of the game.' : 'That is not a Cipher Shift save code.');
    const parts = code.slice(PREFIX.length).split('-');
    if (parts.length !== 2 || check(parts[0]) !== parts[1].toUpperCase()) fail('This save code is incomplete or mistyped. Copy it again.');
    let data;
    try {
      data = JSON.parse(fromB64(parts[0]));
    } catch {
      fail('This save code is incomplete or mistyped. Copy it again.');
    }
    try {
      return validate(data);
    } catch {
      fail('This save code does not describe a valid game.');
    }
  }

  function validate(d) {
    if (!d || d.v !== VERSION || !isInt(d.w, 0, MAX_WINS) || !isInt(d.g, 0, GRAINS.length - 1)) fail('bad');
    const flag = (f) => (f === undefined ? null : f === 1 ? 'on' : f === 0 ? 'off' : fail('bad'));
    if (d.c !== undefined && !isInt(d.c, 0, (1 << MODES.length) - 1)) fail('bad');
    const cleared = d.c === undefined ? null : MODES.filter((_, i) => d.c & (1 << i));
    const save = { wins: d.w, grain: GRAINS[d.g], sound: flag(d.s), music: flag(d.m), cleared, round: null };
    if (d.r === undefined) return save;
    if (!Array.isArray(d.r) || d.r.length !== 8) fail('bad');
    const [m, p, trace, captures, s, c, gs, g] = d.r;
    if (!isInt(m, 0, MODES.length - 1) || !isInt(p, 0, PHASES.length - 1)) fail('bad');
    const mode = MODES[m];
    const phase = PHASES[p];
    const n = L.DIFFICULTY[mode].n;
    if (!isInt(trace, 0, L.TRACE.lockdown - 1)) fail('bad');
    const secret = glyphs(s, n);
    if (!Array.isArray(c) || c.length !== L.CAPTURES_NEEDED) fail('bad');
    const clues = c.map((x) => {
      if (!Array.isArray(x) || x.length !== 3 || !isInt(x[0], 0, KINDS.length - 1) || !isInt(x[1], 0, L.GLYPHS.length - 1)) fail('bad');
      const clue = { kind: KINDS[x[0]], glyph: L.GLYPHS[x[1]] };
      if (clue.kind !== 'absent') clue.slot = isInt(x[2], 0, n - 1) ? x[2] : fail('bad');
      if (!L.clueHolds(clue, secret)) fail('bad');
      return clue;
    });
    if (!Array.isArray(gs) || !Array.isArray(g)) fail('bad');
    let guesses = [];
    let guess = [];
    if (phase === 'intercept') {
      if (!isInt(captures, 0, L.CAPTURES_NEEDED - 1) || gs.length || g.length) fail('bad');
    } else {
      if (captures !== L.CAPTURES_NEEDED || gs.length >= L.DIFFICULTY[mode].tries) fail('bad');
      guesses = gs.map((row) => glyphs(row, n));
      if (guesses.some((row) => row.every((x, i) => x === secret[i]))) fail('bad'); // a solved round has already ended
      guess = glyphs(g, n, true);
    }
    save.round = { mode, phase, trace, captures, secret, clues, guesses, guess };
    return save;
  }

  const api = { VERSION, encode, decode };
  root.CipherSave = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
