// Pure logic with no DOM or audio: the Life rule, link codes, grid resizing, settings validation.
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
  const DEFAULTS = { bpm: 96, volume: 70, evolveEvery: 1, reseed: true, scale: "majpent", voice: "glass", bass: true };

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

  function midiForRow(r, scale) {
    const sc = SCALES[scale] || SCALES.majpent;
    const degree = ROWS - 1 - r;
    return BASE_MIDI + sc[degree % sc.length] + 12 * Math.floor(degree / sc.length);
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
    return s;
  }

  // Link codes. "v2" + step count + grid bits six to a character + six settings characters.
  // Only characters that survive in a URL fragment. "v1" codes (16 steps, no step character) still load.
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function encode(grid, cols, s) {
    let out = "v2" + ALPH[cols];
    for (let k = 0; k < cols * ROWS; k += 6) {
      let v = 0;
      for (let b = 0; b < 6; b++) v = (v << 1) | (grid[k + b] || 0);
      out += ALPH[v];
    }
    const bpm = Math.max(0, Math.min(130, s.bpm - 50));
    return out + ALPH[Math.max(0, SCALE_KEYS.indexOf(s.scale))] + ALPH[Math.max(0, VOICES.indexOf(s.voice))] +
      ALPH[Math.max(0, EVOLVES.indexOf(s.evolveEvery))] + ALPH[bpm >> 6] + ALPH[bpm & 63] + ALPH[s.bass ? 1 : 0];
  }
  function decode(code) {
    if (typeof code !== "string") return null;
    code = code.replace(/^#/, "");
    let cols, body;
    if (/^v1[A-Za-z0-9_-]{38}$/.test(code)) { cols = 16; body = code.slice(2); }
    else if (/^v2[A-Za-z0-9_-]+$/.test(code)) {
      cols = ALPH.indexOf(code[2]);
      if (!STEP_OPTIONS.includes(cols) || code.length !== 3 + cols * 2 + 6) return null;
      body = code.slice(3);
    } else return null;
    const vals = [...body].map(ch => ALPH.indexOf(ch));
    const chars = cols * 2;
    const grid = new Uint8Array(cols * ROWS);
    for (let j = 0; j < chars; j++) for (let b = 0; b < 6; b++) grid[j * 6 + b] = (vals[j] >> (5 - b)) & 1;
    const [sc, vo, ev, b1, b2, bs] = vals.slice(chars);
    return {
      cols, grid,
      settings: {
        scale: SCALE_KEYS[sc] || DEFAULTS.scale, voice: VOICES[vo] || DEFAULTS.voice,
        evolveEvery: EVOLVES[ev] ?? DEFAULTS.evolveEvery, bpm: Math.max(50, Math.min(180, 50 + b1 * 64 + b2)), bass: bs === 1,
      },
    };
  }

  return { ROWS, STEP_OPTIONS, SCALES, SCALE_KEYS, VOICES, EVOLVES, DEFAULTS, neighborCount, lifeStep, markDoomed, remap, midiForRow, sanitize, encode, decode };
})();
