// Pure logic with no DOM or audio: the Life rule, link codes, grid resizing, settings validation,
// starter patterns and MIDI export.
// Loaded before app.js in the page, and on its own by the tests.
const OrvyCore = (() => {
  "use strict";

  const ROWS = 12;
  const STEP_OPTIONS = [12, 16, 24];
  const SCALES = {
    majpent: [0, 2, 4, 7, 9],
    minpent: [0, 3, 5, 7, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    hirajoshi: [0, 2, 3, 7, 8],
    whole: [0, 2, 4, 6, 8, 10],
  };
  const SCALE_KEYS = Object.keys(SCALES);
  const VOICES = ["glass", "reed", "pluck"];
  const EVOLVES = [1, 2, 4, 0];
  const BASE_MIDI = 48; // C3
  const MAX_AGE = 999;
  const ENGINES = ["studio", "classic"];
  const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const MAX_SWING = 60;
  const DEFAULTS = { bpm: 96, volume: 70, evolveEvery: 1, reseed: true, scale: "majpent", voice: "glass", bass: true, key: 0, swing: 0, engine: "studio" };

  const idx = (cols, c, r) => r * cols + c;

  // Lit neighbours on a torus: the grid wraps at every edge.
  function neighborCount(grid, cols, c, r) {
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const rr = (r + dr + ROWS) % ROWS;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr || dc) n += grid[rr * cols + (c + dc + cols) % cols];
      }
    }
    return n;
  }

  // B3/S23. Survivors age by one generation; births start at age 0.
  function lifeStep(grid, age, cols) {
    const n = cols * ROWS;
    const next = new Uint8Array(n), nextAge = new Uint16Array(n);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < cols; c++) {
      const i = idx(cols, c, r), k = neighborCount(grid, cols, c, r);
      next[i] = (k === 3 || (grid[i] && k === 2)) ? 1 : 0;
      if (next[i] && grid[i]) nextAge[i] = Math.min(MAX_AGE, age[i] + 1);
    }
    return { grid: next, age: nextAge };
  }

  // Fills "out" with 1 for each lit cell that goes dark next generation.
  function markDoomed(grid, cols, out) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < cols; c++) {
      const i = idx(cols, c, r);
      if (!grid[i]) { out[i] = 0; continue; }
      const k = neighborCount(grid, cols, c, r);
      out[i] = (k < 2 || k > 3) ? 1 : 0;
    }
    return out;
  }

  // Copies a grid to a new step count, cropping or padding on the right.
  function remap(arr, from, to, Type) {
    const out = new Type(to * ROWS);
    const w = Math.min(from, to);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < w; c++) out[r * to + c] = arr[r * from + c];
    return out;
  }

  // MIDI note for a row: scale degree counted up from the bottom row, transposed by key (0 = C).
  function midiForRow(r, scale, key = 0) {
    const sc = SCALES[scale] || SCALES.majpent;
    const degree = ROWS - 1 - r;
    return BASE_MIDI + (key || 0) + sc[degree % sc.length] + 12 * Math.floor(degree / sc.length);
  }

  // Clamps and repairs settings in place, e.g. ones read back from storage.
  function sanitize(s) {
    const num = (v, lo, hi, d) => Number.isFinite(+v) && v !== null && v !== "" ? Math.max(lo, Math.min(hi, Math.round(+v))) : d;
    if (!SCALES[s.scale]) s.scale = DEFAULTS.scale;
    if (!VOICES.includes(s.voice)) s.voice = DEFAULTS.voice;
    if (!EVOLVES.includes(s.evolveEvery)) s.evolveEvery = DEFAULTS.evolveEvery;
    s.bpm = num(s.bpm, 50, 180, DEFAULTS.bpm);
    s.volume = num(s.volume, 0, 100, DEFAULTS.volume);
    s.reseed = s.reseed !== false;
    s.bass = s.bass !== false;
    s.key = num(s.key, 0, 11, DEFAULTS.key);
    s.swing = num(s.swing, 0, MAX_SWING, DEFAULTS.swing);
    if (!ENGINES.includes(s.engine)) s.engine = DEFAULTS.engine;
    return s;
  }

  // Link codes: "v3" + step count + grid bits six to a character + eight settings characters
  // (scale, voice, evolve, tempo high, tempo low, bass, key, swing). Only characters a URL fragment keeps.
  // Older codes still load: "v2" has six settings characters, "v1" is 16 steps with no step character.
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function encode(grid, cols, s) {
    let out = "v3" + ALPH[cols];
    for (let k = 0; k < cols * ROWS; k += 6) {
      let v = 0;
      for (let b = 0; b < 6; b++) v = (v << 1) | (grid[k + b] || 0);
      out += ALPH[v];
    }
    const bpm = Math.max(0, Math.min(130, s.bpm - 50));
    return out + ALPH[Math.max(0, SCALE_KEYS.indexOf(s.scale))] + ALPH[Math.max(0, VOICES.indexOf(s.voice))] +
      ALPH[Math.max(0, EVOLVES.indexOf(s.evolveEvery))] + ALPH[bpm >> 6] + ALPH[bpm & 63] + ALPH[s.bass ? 1 : 0] +
      ALPH[Math.max(0, Math.min(11, s.key || 0))] + ALPH[Math.max(0, Math.min(MAX_SWING, s.swing || 0))];
  }
  function decode(code) {
    if (typeof code !== "string") return null;
    code = code.replace(/^#/, "");
    let cols, body, extra;
    if (/^v1[A-Za-z0-9_-]{38}$/.test(code)) { cols = 16; body = code.slice(2); extra = 6; }
    else if (/^v[23][A-Za-z0-9_-]+$/.test(code)) {
      cols = ALPH.indexOf(code[2]);
      extra = code[1] === "3" ? 8 : 6;
      if (!STEP_OPTIONS.includes(cols) || code.length !== 3 + cols * 2 + extra) return null;
      body = code.slice(3);
    } else return null;
    const vals = [...body].map(ch => ALPH.indexOf(ch));
    const chars = cols * 2;
    const grid = new Uint8Array(cols * ROWS);
    for (let j = 0; j < chars; j++) for (let b = 0; b < 6; b++) grid[j * 6 + b] = (vals[j] >> (5 - b)) & 1;
    const [sc, vo, ev, b1, b2, bs, key = 0, swing = 0] = vals.slice(chars);
    return {
      cols, grid,
      settings: {
        scale: SCALE_KEYS[sc] || DEFAULTS.scale, voice: VOICES[vo] || DEFAULTS.voice,
        evolveEvery: EVOLVES[ev] ?? DEFAULTS.evolveEvery, bpm: Math.max(50, Math.min(180, 50 + b1 * 64 + b2)), bass: bs === 1,
        key: Math.min(11, key), swing: Math.min(MAX_SWING, swing),
      },
    };
  }

  // Starter patterns, laid out for 16 steps (they wrap on other lengths). Each entry is rows of "O"
  // for lit cells, then the column and row of its top-left corner.
  const SCENES = {
    // Two gliders flying the same way, so they never collide.
    gliders: [[".O.", "..O", "OOO", 1, 1], [".O.", "..O", "OOO", 9, 6]],
    osc: [[".OOO", "OOO.", 1, 2], ["OO..", "OO..", "..OO", "..OO", 7, 1], ["OOO", 12, 8], ["O", "O", "O", 3, 7]],
    // Four blinkers a beat apart: a melody on one bar, chords on the next, forever.
    pulse: [["OOO", 1, 8], ["OOO", 5, 6], ["OOO", 9, 7], ["OOO", 13, 4]],
    // Two gliders and a toad that meet, scatter and settle after about 34 generations.
    canon: [[".O.", "..O", "OOO", 1, 1], ["OOO", "O..", ".O.", 9, 6], [".OOO", "OOO.", 11, 1]],
    // An R-pentomino: grows and churns for a long time.
    chaos: [[".OO", "OO.", ".O.", 7, 4], ["OOO", 1, 9]],
    // A spaceship drifting past a toad; settles into a slow oscillation after about 59 generations.
    drift: [[".O..O", "O....", "O...O", "OOOO.", 2, 1], [".OOO", "OOO.", 8, 8]],
  };
  function sceneGrid(name, cols) {
    const grid = new Uint8Array(cols * ROWS);
    (SCENES[name] || []).forEach(spec => {
      const r0 = spec[spec.length - 1], c0 = spec[spec.length - 2];
      spec.slice(0, -2).forEach((line, r) => [...line].forEach((ch, c) => {
        if (ch === "O") grid[((r0 + r) % ROWS) * cols + (c0 + c) % cols] = 1;
      }));
    });
    return grid;
  }

  // Voice choice per step, shared by playback and MIDI export: newest cells first, then the ones about
  // to die, at most "max" per step.
  function chooseVoices(grid, age, doomed, cols, step, max) {
    const cands = [];
    for (let r = 0; r < ROWS; r++) { const i = r * cols + step; if (grid[i]) cands.push(i); }
    cands.sort((a, b) => (age[a] - age[b]) || (doomed[b] - doomed[a]));
    return cands.slice(0, max);
  }
  const ageLevel = a => a === 0 ? 1 : a < 3 ? 0.78 : a < 6 ? 0.6 : 0.48;
  const MAX_VOICES = 4;

  // Standard MIDI file (format 0) of the next "bars" bars, played from this grid with these settings.
  // Notes on channel 1, bass on channel 2. Evolution, voice choice, swing and dynamics match playback.
  const GM_PROGRAMS = { glass: 11, reed: 21, pluck: 45 }; // vibraphone, accordion, pizzicato strings
  function renderMidi(grid, age, cols, s, bars) {
    const PPQ = 96, stepTicks = PPQ / 4, swingTicks = Math.round(stepTicks * (s.swing || 0) / 100 * 0.5);
    const events = [];
    let g = grid.slice(), a = age.slice();
    for (let bar = 0; bar < bars; bar++) {
      if (bar > 0 && s.evolveEvery && bar % s.evolveEvery === 0) {
        const next = lifeStep(g, a, cols); g = next.grid; a = next.age;
      }
      if (!g.some(v => v)) break;
      const doomed = markDoomed(g, cols, new Uint8Array(g.length));
      const barStart = bar * cols * stepTicks;
      if (s.bass) {
        let low = -1;
        for (let r = ROWS - 1; r >= 0 && low < 0; r--) for (let c = 0; c < cols; c++) if (g[r * cols + c]) { low = r; break; }
        if (low >= 0) {
          const note = midiForRow(low, s.scale, s.key) - 12;
          events.push([barStart, 1, 0x91, note, 72], [barStart + cols * stepTicks - 1, 0, 0x81, note, 0]);
        }
      }
      for (let st = 0; st < cols; st++) {
        const t = barStart + st * stepTicks + (st % 2 ? swingTicks : 0);
        for (const i of chooseVoices(g, a, doomed, cols, st, MAX_VOICES)) {
          const note = midiForRow(Math.floor(i / cols), s.scale, s.key);
          const len = doomed[i] ? stepTicks / 2 : a[i] >= 6 ? stepTicks * 3 : stepTicks * 2;
          events.push([t, 1, 0x90, note, Math.round(40 + 87 * ageLevel(a[i]))], [t + len, 0, 0x80, note, 0]);
        }
      }
    }
    // Note-offs sort before note-ons at the same tick so repeated notes retrigger cleanly.
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const vlq = n => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
    const usec = Math.round(60000000 / s.bpm);
    const track = [0, 0xff, 0x51, 3, (usec >> 16) & 255, (usec >> 8) & 255, usec & 255,
      0, 0xff, 0x58, 4, 4, 2, 24, 8,
      0, 0xc0, GM_PROGRAMS[s.voice] ?? 11, 0, 0xc1, 38];
    let last = 0;
    for (const [t, , status, note, vel] of events) { track.push(...vlq(t - last), status, note, vel); last = t; }
    track.push(0, 0xff, 0x2f, 0);
    const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const head = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255];
    return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track]);
  }

  return {
    ROWS, STEP_OPTIONS, SCALES, SCALE_KEYS, VOICES, EVOLVES, ENGINES, KEY_NAMES, MAX_SWING, MAX_VOICES, DEFAULTS, SCENES,
    neighborCount, lifeStep, markDoomed, remap, midiForRow, sanitize, encode, decode, sceneGrid, chooseVoices, ageLevel, renderMidi,
  };
})();
