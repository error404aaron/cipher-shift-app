/* Cipher Shift sound: every effect and the music score are synthesised with the Web Audio API (no audio files,
   works offline). The audio context is created on the first tap or key press, as browsers require, and only while
   sound or music is on. */
(function (root) {
  'use strict';
  const VOLUME = 0.3;
  let ctx = null;
  let master = null;
  let musicBus = null;
  let noiseBuffer = null;
  let enabled = true;
  let primed = false;
  const recent = []; // names of the last effects played, newest last (read by the browser tests)

  function context() {
    if (ctx || !(enabled || music.on)) return ctx;
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
    musicBus = ctx.createGain();
    musicBus.gain.value = 0;
    musicBus.connect(master);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }
  // Safari only lets audio start inside the handler of a completed gesture (touchend, click, keydown), and iPhone
  // also wants a sound started there; a one-sample silent buffer does that. 'interrupted' (after a call or an app
  // switch on iPhone) needs a resume just like 'suspended'.
  function wake(c) {
    if (c.state !== 'running') c.resume().catch(() => {});
  }
  function unlock() {
    const c = context();
    if (!c) return;
    wake(c);
    // pointerdown alone does not count in Safari, so keep priming on each gesture until the context really runs.
    if (primed && c.state === 'running') return;
    primed = true;
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, c.sampleRate);
    src.connect(c.destination);
    src.start(0);
    updateMusic();
  }

  // An enveloped oscillator note: quick attack (or `attack` seconds), exponential fade, optional low-pass `cut`.
  function tone(freq, dur, { type = 'square', gain = 0.5, to = 0, at = 0, out = master, attack = 0.008, cut = 0 } = {}) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let head = osc;
    if (cut) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cut;
      head = osc.connect(filter);
    }
    head.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  // Filtered noise burst; `sweep` moves the band-pass centre over the burst.
  function noise(dur, { freq = 1200, sweep = 0, q = 1, gain = 0.4, at = 0, kind = 'bandpass', out = master } = {}) {
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
    src.connect(filter).connect(env).connect(out);
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

  /* ---------- Music ---------- */

  // An adaptive score, synthesised step by step: A minor, i-VI-iv-V (Am F Dm E), 16th-note grid. The mood picks
  // which layers play: calm (welcome, paused) is a pad and sub; hunt (intercept) adds a bass pulse and hats; crack
  // (decode) adds an arpeggio; danger (trace 75%+) adds a kick and doubles the hats. 'off' fades the score out.
  const BPM = 104;
  const STEP = 60 / BPM / 4;
  const CHORDS = [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]];
  const LAYERS = {
    off: [],
    calm: ['pad', 'sub'],
    hunt: ['pad', 'bass', 'hat'],
    crack: ['pad', 'bass', 'hat', 'arp'],
    danger: ['pad', 'bass', 'hat', 'arp', 'kick'],
  };
  const MUSIC_VOLUME = 0.55;
  const note = (n) => 440 * 2 ** ((n - 69) / 12);
  const music = { on: true, mood: 'off', timer: 0, next: 0, step: 0, steps: 0, fade: 0 };

  function scheduleStep(s, t) {
    const at = Math.max(0, t - ctx.currentTime);
    const pos = s % 16;
    const chord = CHORDS[Math.floor(s / 16) % CHORDS.length];
    const layers = LAYERS[music.mood];
    const out = musicBus;
    if (layers.includes('pad') && pos === 0) {
      for (const n of chord) {
        for (const detune of [-6, 6]) {
          tone(note(n) * 2 ** (detune / 1200), STEP * 16, { type: 'sawtooth', gain: 0.05, at, out, attack: 0.5, cut: 900 });
        }
      }
    }
    if (layers.includes('sub') && pos === 0) tone(note(chord[0] - 24), STEP * 15, { type: 'sine', gain: 0.22, at, out, attack: 0.3 });
    if (layers.includes('bass') && pos % 2 === 0) {
      const n = chord[0] - 24 + (pos === 6 || pos === 14 ? 12 : 0);
      tone(note(n), STEP * 1.6, { type: 'square', gain: 0.16, at, out, cut: 520 });
    }
    if (layers.includes('hat') && (pos % 4 === 2 || (layers.includes('kick') && pos % 2 === 1))) {
      noise(0.03, { freq: 8000, kind: 'highpass', gain: pos % 4 === 2 ? 0.1 : 0.05, at, out });
    }
    if (layers.includes('arp')) {
      const n = [chord[0], chord[1], chord[2], chord[0] + 12][pos % 4] + 12;
      tone(note(n), STEP * 0.9, { type: 'triangle', gain: 0.07, at, out });
    }
    if (layers.includes('kick') && pos % 4 === 0) tone(150, 0.2, { type: 'sine', gain: 0.45, to: 42, at, out });
  }
  // Look-ahead scheduler: a timer tops up the next 150 ms of steps on the audio clock, so timer jitter never shows.
  function tick() {
    if (!ctx || ctx.state !== 'running') return;
    const ahead = ctx.currentTime + 0.15;
    if (music.next < ctx.currentTime - 0.05) music.next = ctx.currentTime + 0.02; // came back from a suspend
    while (music.next < ahead) {
      scheduleStep(music.step, music.next);
      music.next += STEP;
      music.step++;
      music.steps++;
    }
  }
  function updateMusic() {
    if (!ctx) return;
    const playing = music.on && music.mood !== 'off';
    clearTimeout(music.fade);
    const t = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(musicBus.gain.value, t);
    if (playing) {
      musicBus.gain.linearRampToValueAtTime(MUSIC_VOLUME, t + 0.4);
      if (!music.timer) {
        music.step = 0; // start each piece on the downbeat of the first chord
        music.next = t + 0.05;
        music.timer = setInterval(tick, 40);
        tick();
      }
    } else if (music.timer) {
      musicBus.gain.linearRampToValueAtTime(0, t + 0.6);
      music.fade = setTimeout(() => {
        clearInterval(music.timer);
        music.timer = 0;
      }, 700);
    }
  }
  function setMood(mood) {
    if (!LAYERS[mood] || mood === music.mood) return;
    music.mood = mood;
    updateMusic();
  }

  function play(name) {
    if (!enabled || !EFFECTS[name]) return;
    const c = context();
    if (!c) return;
    wake(c);
    EFFECTS[name]();
    recent.push(name);
    if (recent.length > 30) recent.shift();
  }
  // Effects and music switch separately; the audio only sleeps when both are off.
  // Only touch audio that already exists: creating it here (at page load) would happen without a user gesture.
  function sync() {
    if (ctx) (enabled || music.on ? ctx.resume() : ctx.suspend()).catch(() => {});
  }
  function setEnabled(on) {
    enabled = !!on;
    sync();
  }
  function setMusic(on) {
    music.on = !!on;
    sync();
    updateMusic();
  }

  // Stay silent in a background tab.
  root.document?.addEventListener('visibilitychange', () => {
    if (!ctx || !(enabled || music.on)) return;
    (document.hidden ? ctx.suspend() : ctx.resume()).catch(() => {});
  });

  root.CipherSound = {
    play, unlock, setEnabled, setMusic, setMood, EFFECTS: Object.keys(EFFECTS), MOODS: Object.keys(LAYERS), recent,
    get music() { return music.on; },
    get mood() { return music.mood; },
    get musicSteps() { return music.steps; }, // 16th-note steps scheduled so far (read by the browser tests)
    get musicPlaying() { return !!music.timer; },
    get time() { return ctx ? ctx.currentTime : 0; },
    get enabled() { return enabled; },
    get state() { return ctx ? ctx.state : 'none'; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
