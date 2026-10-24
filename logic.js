/* Cipher Shift game rules: pure functions with an injectable random source so they can be tested in Node. */
(function (root) {
  'use strict';

  const GLYPHS = ['△', '○', '◇', '⊕', '≋', '⌁'];

  // Levels in ladder order (save codes store the index, so new levels go at the end).
  // n: key length; speed: stream px/s; hazards: security probes per loop; nearMiss: decoys that differ from the
  // reference by `mutate` tokens (the rest differ by at least 3); tries: key submissions; trace: % added by a wrong
  // block, a probe, a refresh and a rejected key; unlockAfter: the level whose win unlocks this one.
  const DIFFICULTY = {
    easy: { label: 'Training', n: 3, speed: 16, hazards: 1, nearMiss: 1, mutate: 2, tries: 6, trace: { miss: 8, probe: 16, refresh: 3, submit: 8 } },
    standard: { label: 'Standard', n: 4, speed: 24, hazards: 2, nearMiss: 4, mutate: 2, tries: 5, trace: { miss: 12, probe: 24, refresh: 5, submit: 12 } },
    hard: { label: 'Expert', n: 5, speed: 32, hazards: 3, nearMiss: 5, mutate: 1, tries: 5, trace: { miss: 15, probe: 28, refresh: 8, submit: 16 }, unlockAfter: 'standard' },
    elite: { label: 'Black ICE', n: 5, speed: 40, hazards: 3, nearMiss: 7, mutate: 1, tries: 4, trace: { miss: 20, probe: 35, refresh: 10, submit: 20 }, unlockAfter: 'hard' },
  };
  const LEVELS = Object.keys(DIFFICULTY);
  const TRACE = { lockdown: 100 };
  const MAX_SUBMISSIONS = Math.max(...LEVELS.map((m) => DIFFICULTY[m].tries));
  const CAPTURES_NEEDED = 3;
  const BLOCKS_PER_LOOP = 9;

  // Every line stays within 14 characters so three lanes fit a phone without wrapping.
  const TOKENS = {
    v: ['key', 'sig', 'buf', 'net', 'pkt', 'mem'],
    f: ['scan', 'read', 'pull', 'sync', 'peek', 'tap'],
    h: ['1F', '3A', '7E', '7F', 'B4', 'C2', 'D9', 'E0'],
    c: ['trace', 'noise', 'clock', 'depth', 'drift', 'heat'],
    op: ['<', '>'],
    n: ['12', '21', '40', '48', '64', '84'],
    g: ['route', 'flush', 'relay', 'patch', 'spoof', 'mask'],
    w: ['key', 'sig', 'buf', 'net', 'pkt', 'mem'],
    t: ['end', 'ret', 'jmp', 'ack'],
    k: ['0x0A', '0x1F', '0x2C', '0x5B', '0x6D', '0x9E'],
  };
  const TOKEN_KEYS = Object.keys(TOKENS);
  const MAX_LINE = 14;

  function randInt(rng, n) {
    return Math.floor(rng() * n);
  }
  function pick(rng, list) {
    return list[randInt(rng, list.length)];
  }
  // Unbiased Fisher-Yates shuffle (the prototype used a biased sort comparator).
  function shuffle(list, rng = Math.random) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(rng, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function makeSecret(n, rng = Math.random) {
    if (!(n >= 1 && n <= GLYPHS.length)) throw new RangeError('key length out of range');
    return shuffle(GLYPHS, rng).slice(0, n);
  }

  // Feedback for a nonrepeating key and guess: exact, present (wrong position) or absent.
  function scoreGuess(secret, guess) {
    return guess.map((g, i) => (g === secret[i] ? 'exact' : secret.includes(g) ? 'present' : 'absent'));
  }

  // Three intercepted clues, all true for `secret`, each about a different glyph:
  // 1) a key glyph and one slot it is NOT in, 2) a glyph absent from the key, 3) a key glyph locked to its slot.
  function makeClues(secret, rng = Math.random) {
    const n = secret.length;
    const order = shuffle([...secret.keys()], rng);
    const presentIdx = order[0];
    const exactIdx = order[1 % n];
    const notSlot = shuffle([...secret.keys()].filter((i) => i !== presentIdx), rng)[0];
    const absent = pick(rng, GLYPHS.filter((g) => !secret.includes(g)));
    return [
      { kind: 'present', glyph: secret[presentIdx], slot: notSlot },
      { kind: 'absent', glyph: absent },
      { kind: 'exact', glyph: secret[exactIdx], slot: exactIdx },
    ];
  }
  function clueText(c) {
    const key = c.glyph + ' (key ' + (GLYPHS.indexOf(c.glyph) + 1) + ')';
    if (c.kind === 'present') return key + ' is in the key, but not in slot ' + (c.slot + 1) + '.';
    if (c.kind === 'absent') return key + ' is not in the key.';
    return key + ' belongs in slot ' + (c.slot + 1) + '.';
  }
  function clueHolds(c, secret) {
    if (c.kind === 'absent') return !secret.includes(c.glyph);
    if (c.kind === 'exact') return secret[c.slot] === c.glyph;
    return secret.includes(c.glyph) && secret[c.slot] !== c.glyph;
  }

  function randomTokens(rng) {
    const t = {};
    for (const k of TOKEN_KEYS) t[k] = pick(rng, TOKENS[k]);
    return t;
  }
  function codeText(t) {
    return [t.v + ' = ' + t.f + '(' + t.h + ')', 'if ' + t.c + ' ' + t.op + ' ' + t.n, '  ' + t.g + '(' + t.w + ')', t.t + ' ' + t.k].join('\n');
  }
  function tokenDistance(a, b) {
    return TOKEN_KEYS.filter((k) => a[k] !== b[k]).length;
  }
  function mutate(t, count, rng) {
    const out = { ...t };
    for (const k of shuffle(TOKEN_KEYS, rng).slice(0, count)) out[k] = pick(rng, TOKENS[k].filter((x) => x !== t[k]));
    return out;
  }

  // One loop of the intercept stream: exactly one block matches the reference, all blocks are distinct,
  // the match is never a security probe, and decoys are near-misses according to difficulty.
  function makeStream(mode, rng = Math.random) {
    const cfg = DIFFICULTY[mode] ?? DIFFICULTY.standard;
    const ref = randomTokens(rng);
    const seen = new Set([codeText(ref)]);
    const decoys = [];
    for (let i = 0; decoys.length < BLOCKS_PER_LOOP - 1; i++) {
      const near = decoys.length < cfg.nearMiss;
      const t = near ? mutate(ref, cfg.mutate, rng) : i > 200 ? randomTokens(rng) : mutate(ref, 3 + randInt(rng, 4), rng);
      const code = codeText(t);
      if (!seen.has(code)) {
        seen.add(code);
        decoys.push(code);
      }
    }
    const target = codeText(ref);
    const codes = shuffle([target, ...decoys], rng);
    const hazardSlots = new Set(shuffle(codes.map((_, i) => i).filter((i) => codes[i] !== target), rng).slice(0, cfg.hazards));
    return {
      target,
      blocks: codes.map((code, i) => ({ id: i, code, correct: code === target, hazard: hazardSlots.has(i) })),
    };
  }

  // Progression ladder. `cleared` lists the levels won at least once. A level is open when it has no requirement or
  // when its required level, or any level above that, has been cleared.
  function unlocked(mode, cleared) {
    const need = DIFFICULTY[mode]?.unlockAfter;
    if (!DIFFICULTY[mode]) return false;
    if (!need) return true;
    return [...cleared].some((c) => LEVELS.indexOf(c) >= LEVELS.indexOf(need));
  }
  // The levels that a win on `mode` opens for the first time.
  function newlyUnlocked(mode, cleared) {
    const after = new Set([...cleared, mode]);
    return LEVELS.filter((m) => !unlocked(m, cleared) && unlocked(m, after));
  }

  const api = {
    GLYPHS, DIFFICULTY, LEVELS, TRACE, MAX_SUBMISSIONS, CAPTURES_NEEDED, BLOCKS_PER_LOOP, MAX_LINE, TOKENS,
    shuffle, makeSecret, scoreGuess, makeClues, clueText, clueHolds, codeText, tokenDistance, makeStream, unlocked, newlyUnlocked,
  };
  root.CipherLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
