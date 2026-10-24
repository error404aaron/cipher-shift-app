/* Cipher Shift sound: every effect is synthesised with the Web Audio API (no audio files, works offline).
   The audio context is created on the first tap or key press, as browsers require, and only while sound is on. */
(function (root) {
  'use strict';
  const VOLUME = 0.3;
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = true;
  const recent = []; // names of the last effects played, newest last (read by the browser tests)

  function context() {
    if (ctx || !enabled) return ctx;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    // iPhone: 'ambient' follows the silent switch and mixes with music instead of stopping it.
    try {
      if (root.navigator?.audioSession) root.navigator.audioSession.type = 'ambient';
    } catch {
      /* not supported */
    }
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }
  function unlock() {
    const c = context();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  // A short enveloped oscillator note: quick attack, exponential fade.
  function tone(freq, dur, { type = 'square', gain = 0.5, to = 0, at = 0 } = {}) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  // Filtered noise burst; `sweep` moves the band-pass centre over the burst.
  function noise(dur, { freq = 1200, sweep = 0, q = 1, gain = 0.4, at = 0, kind = 'bandpass' } = {}) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    src.buffer = noiseBuffer;
    filter.type = kind;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (sweep) filter.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  const EFFECTS = {
    capture() { // bright two-step chirp, then a burst of decrypt chatter
      tone(660, 0.08, { gain: 0.35 });
      tone(990, 0.14, { gain: 0.35, at: 0.07 });
      for (let i = 0; i < 6; i++) tone(1400 + Math.random() * 900, 0.025, { type: 'triangle', gain: 0.12, at: 0.2 + i * 0.035 });
    },
    miss() { // dull falling buzz
      tone(150, 0.2, { type: 'sawtooth', gain: 0.35, to: 85 });
    },
    probe() { // two-tone alarm with static
      tone(880, 0.09, { gain: 0.3 });
      tone(620, 0.12, { gain: 0.3, at: 0.1 });
      noise(0.18, { freq: 3000, q: 0.7, gain: 0.25 });
    },
    refresh() { // whoosh as the stream is replaced
      noise(0.32, { freq: 400, sweep: 2600, q: 2, gain: 0.35 });
    },
    key() { // glyph key click
      tone(1250, 0.03, { gain: 0.12 });
    },
    erase() {
      tone(520, 0.045, { type: 'triangle', gain: 0.2 });
    },
    rejected() { // submitted key refused
      tone(520, 0.1, { gain: 0.28 });
      tone(350, 0.18, { gain: 0.28, at: 0.1 });
    },
    decode() { // power-on sweep into the cipher layer
      tone(180, 0.4, { type: 'sine', gain: 0.4, to: 820 });
      noise(0.35, { freq: 300, sweep: 1800, q: 3, gain: 0.15 });
    },
    warn() { // trace crossed 75% or 90%
      tone(1040, 0.06, { gain: 0.25 });
      tone(1040, 0.06, { gain: 0.25, at: 0.12 });
    },
    win() { // rising arpeggio
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: 'triangle', gain: 0.35, at: i * 0.08 }));
      tone(1568, 0.35, { type: 'sine', gain: 0.2, at: 0.32 });
    },
    lose() { // lockdown: long falling saw with rumble
      tone(320, 0.7, { type: 'sawtooth', gain: 0.35, to: 55 });
      noise(0.6, { freq: 600, sweep: 120, kind: 'lowpass', gain: 0.3 });
    },
    pause() {
      tone(440, 0.06, { type: 'sine', gain: 0.25 });
    },
    resume() {
      tone(660, 0.06, { type: 'sine', gain: 0.25 });
    },
  };

  function play(name) {
    if (!enabled || !EFFECTS[name]) return;
    const c = context();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    EFFECTS[name]();
    recent.push(name);
    if (recent.length > 30) recent.shift();
  }
  function setEnabled(on) {
    enabled = !!on;
    // Only touch audio that already exists: creating it here (at page load) would happen without a user gesture.
    if (ctx) (enabled ? ctx.resume() : ctx.suspend()).catch(() => {});
  }

  // Stay silent in a background tab.
  root.document?.addEventListener('visibilitychange', () => {
    if (!ctx || !enabled) return;
    (document.hidden ? ctx.suspend() : ctx.resume()).catch(() => {});
  });

  root.CipherSound = {
    play, unlock, setEnabled, EFFECTS: Object.keys(EFFECTS), recent,
    get enabled() { return enabled; },
    get state() { return ctx ? ctx.state : 'none'; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
