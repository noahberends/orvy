// Run with: python3 tests/run.py
const C = OrvyCore, R = C.ROWS;
let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; print("ok   " + name); }
  catch (e) { failed++; print("FAIL " + name + "\n     " + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "") + " expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)); }
function gridOf(cols, cells) { const g = new Uint8Array(cols * R); cells.forEach(([c, r]) => { g[r * cols + c] = 1; }); return g; }
function same(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
function run(g, cols, n) { let age = new Uint16Array(g.length); for (let i = 0; i < n; i++) { const s = C.lifeStep(g, age, cols); g = s.grid; age = s.age; } return { grid: g, age }; }

test("B3/S23 for every neighbour count", () => {
  const ring = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (let k = 0; k <= 8; k++) for (const alive of [0, 1]) {
    const cells = ring.slice(0, k).map(([dc, dr]) => [5 + dc, 5 + dr]);
    if (alive) cells.push([5, 5]);
    const next = run(gridOf(16, cells), 16, 1).grid[5 * 16 + 5];
    eq(next, (k === 3 || (alive && k === 2)) ? 1 : 0, (alive ? "lit" : "dark") + " cell with " + k + " neighbours:");
  }
});
test("block is a still life", () => {
  const g = gridOf(16, [[3, 3], [4, 3], [3, 4], [4, 4]]);
  eq(same(run(g, 16, 1).grid, g), true);
});
test("blinker has period 2", () => {
  const g = gridOf(16, [[5, 5], [6, 5], [7, 5]]);
  const one = run(g, 16, 1).grid;
  eq(same(one, g), false, "changes after one step:");
  eq(same(one, gridOf(16, [[6, 4], [6, 5], [6, 6]])), true, "turns vertical:");
  eq(same(run(g, 16, 2).grid, g), true, "returns after two:");
});
test("glider moves one cell diagonally every 4 generations", () => {
  const g = gridOf(16, [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
  const moved = gridOf(16, [[2, 1], [3, 2], [1, 3], [2, 3], [3, 3]]);
  eq(same(run(g, 16, 4).grid, moved), true);
});
test("glider wraps around the torus back to its start", () => {
  for (const cols of C.STEP_OPTIONS) {
    const g = gridOf(cols, [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
    const lcm = (a, b) => { const gcd = (x, y) => y ? gcd(y, x % y) : x; return a * b / gcd(a, b); };
    eq(same(run(g, cols, 4 * lcm(cols, R)).grid, g), true, cols + " steps:");
  }
});
test("survivors age, births start at 0", () => {
  const g = gridOf(16, [[3, 3], [4, 3], [3, 4], [4, 4]]);
  eq(run(g, 16, 5).age[3 * 16 + 3], 5);
  const b = run(gridOf(16, [[5, 5], [6, 5], [7, 5]]), 16, 1);
  eq(b.age[5 * 16 + 6], 1, "centre survives:");
  eq(b.age[4 * 16 + 6], 0, "new cell:");
});
test("doomed marks the blinker's ends", () => {
  const g = gridOf(16, [[5, 5], [6, 5], [7, 5]]);
  const d = C.markDoomed(g, 16, new Uint8Array(g.length));
  eq(d[5 * 16 + 5] + d[5 * 16 + 7], 2, "ends:");
  eq(d[5 * 16 + 6], 0, "centre:");
});
test("remap crops and pads on the right", () => {
  const g = gridOf(24, [[0, 0], [11, 5], [20, 11]]);
  const c12 = C.remap(g, 24, 12, Uint8Array);
  eq(c12.length, 12 * R);
  eq(c12[0] + c12[5 * 12 + 11], 2, "kept:");
  eq(Array.from(c12).reduce((a, b) => a + b, 0), 2, "cropped:");
  const back = C.remap(c12, 12, 24, Uint8Array);
  eq(back[5 * 24 + 11], 1, "padded keeps cells:");
});
test("link codes round-trip at every length and setting", () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const cols of C.STEP_OPTIONS) for (const scale of C.SCALE_KEYS) for (const evolveEvery of C.EVOLVES) {
    const g = new Uint8Array(cols * R).map(() => rnd() < 0.3 ? 1 : 0);
    const s = { scale, voice: C.VOICES[Math.floor(rnd() * 3)], evolveEvery, bpm: 50 + Math.floor(rnd() * 131), bass: rnd() < 0.5,
      key: Math.floor(rnd() * 12), swing: Math.floor(rnd() * (C.MAX_SWING + 1)) };
    const code = C.encode(g, cols, s);
    if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("unsafe character in " + code);
    const d = C.decode("#" + code);
    eq(d.cols, cols);
    eq(same(d.grid, g), true, "grid " + cols + ":");
    for (const k of ["scale", "voice", "evolveEvery", "bpm", "bass", "key", "swing"]) eq(d.settings[k], s[k], k + ":");
  }
});
test("older v1 and v2 codes still load, without key or swing", () => {
  const g = gridOf(16, [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
  const v3 = C.encode(g, 16, { scale: "dorian", voice: "reed", evolveEvery: 2, bpm: 96, bass: true, key: 5, swing: 30 });
  const v2 = "v2" + v3.slice(2, -2), v1 = "v1" + v3.slice(3, -2);
  for (const [name, code] of [["v2", v2], ["v1", v1]]) {
    const d = C.decode(code);
    eq(d.cols, 16, name + " cols:"); eq(same(d.grid, g), true, name + " grid:"); eq(d.settings.scale, "dorian", name + " scale:");
    eq(d.settings.key, 0, name + " key:"); eq(d.settings.swing, 0, name + " swing:");
  }
});
test("bad codes are rejected", () => {
  const good = C.encode(new Uint8Array(16 * R), 16, C.DEFAULTS);
  for (const bad of ["", "v2", good + "A", good.slice(0, -1), "v4" + good.slice(2), good.replace(/.$/, "!"), "v2N" + good.slice(3), null, 42]) {
    eq(C.decode(bad), null, JSON.stringify(bad) + ":");
  }
});
test("sanitize repairs bad settings and keeps good ones", () => {
  const s = C.sanitize({ scale: "nope", voice: 3, evolveEvery: 7, bpm: 9999, volume: "loud", reseed: false, bass: undefined });
  eq(s.scale, "majpent"); eq(s.voice, "glass"); eq(s.evolveEvery, 1); eq(s.bpm, 180); eq(s.volume, 70); eq(s.reseed, false); eq(s.bass, true);
  const z = C.sanitize({ scale: "whole", voice: "pluck", evolveEvery: 0, bpm: 50, volume: 0 });
  eq(z.volume, 0, "volume 0 stays 0:"); eq(z.evolveEvery, 0); eq(z.scale, "whole");
  const k = C.sanitize({ key: 14, swing: -5, engine: "turbo" });
  eq(k.key, 11, "key clamped:"); eq(k.swing, 0, "swing clamped:"); eq(k.engine, "studio", "engine:");
  eq(C.sanitize({ key: "x" }).key, 0, "bad key:");
});
test("rows map to scale notes, lowest at the bottom", () => {
  eq(C.midiForRow(R - 1, "majpent"), 48, "C3:");
  eq(C.midiForRow(0, "majpent"), 74, "D5:");
  eq(C.midiForRow(R - 1, "missing"), 48, "unknown scale falls back:");
  eq(C.midiForRow(R - 1, "majpent", 2), 50, "key of D:");
  eq(C.midiForRow(0, "majpent", 11) - C.midiForRow(0, "majpent", 0), 11, "key transposes every row:");
});
test("starter patterns: pulse repeats every 2 generations, the rest stay alive", () => {
  const p = C.sceneGrid("pulse", 16);
  eq(same(run(p, 16, 2).grid, p), true, "pulse period 2:");
  for (const name of Object.keys(C.SCENES)) {
    const g = C.sceneGrid(name, 16);
    eq(g.some(v => v), true, name + " not empty:");
    eq(run(g, 16, 24).grid.some(v => v), true, name + " alive after 24 generations:");
  }
  eq(C.sceneGrid("pulse", 24).length, 24 * R, "other lengths:");
});
test("voice choice: newest first, then doomed, at most four", () => {
  const cols = 16, g = new Uint8Array(cols * R), age = new Uint16Array(cols * R), doomed = new Uint8Array(cols * R);
  [[0, 5], [2, 0], [4, 3], [6, 0], [8, 9], [10, 1]].forEach(([r, a]) => { g[r * cols + 3] = 1; age[r * cols + 3] = a; });
  doomed[6 * cols + 3] = 1;
  const picked = C.chooseVoices(g, age, doomed, cols, 3, 4).map(i => Math.floor(i / cols));
  eq(JSON.stringify(picked), JSON.stringify([6, 2, 10, 4]));
});

// Minimal MIDI reader for the export tests.
function readMidi(bytes) {
  const str = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
  const u32 = o => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (str(0, 4) !== "MThd" || str(14, 4) !== "MTrk") throw new Error("bad chunk headers");
  const end = 22 + u32(18);
  if (end !== bytes.length) throw new Error("track length " + (end - 22) + " does not match file");
  let p = 22, t = 0; const notes = [], tempo = [];
  const vlq = () => { let n = 0, b; do { b = bytes[p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
  while (p < end) {
    t += vlq();
    const st = bytes[p++];
    if (st === 0xff) { const type = bytes[p++], len = vlq(); if (type === 0x51) tempo.push((bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]); p += len; }
    else if ((st & 0xf0) === 0xc0) p += 1;
    else { const note = bytes[p++], vel = bytes[p++]; if ((st & 0xf0) === 0x90 && vel > 0) notes.push({ t, ch: st & 15, note, vel }); }
  }
  return { ppq: (bytes[12] << 8) | bytes[13], notes, tempo };
}
test("MIDI export: valid file, notes match the grid's evolution", () => {
  const blinker = gridOf(16, [[5, 5], [6, 5], [7, 5]]);
  const base = { scale: "majpent", voice: "glass", bpm: 120, bass: false, key: 0, swing: 0, evolveEvery: 1 };
  const m = readMidi(C.renderMidi(blinker, new Uint16Array(blinker.length), 16, base, 2));
  eq(m.ppq, 96, "ppq:");
  eq(m.tempo[0], 500000, "120 bpm:");
  eq(m.notes.length, 6, "bar 1 plays 3 single notes, bar 2 one 3-note chord:");
  eq(m.notes.filter(n => n.t === 16 * 24 + 6 * 24).length, 3, "the chord lands on step 7 of bar 2:");
  const frozen = readMidi(C.renderMidi(blinker, new Uint16Array(blinker.length), 16, { ...base, evolveEvery: 0 }, 4));
  eq(frozen.notes.length, 12, "frozen grid repeats bar 1:");
  const withBass = readMidi(C.renderMidi(blinker, new Uint16Array(blinker.length), 16, { ...base, bass: true, evolveEvery: 0 }, 2));
  eq(withBass.notes.filter(n => n.ch === 1).length, 2, "one bass note per bar on channel 2:");
});
test("MIDI export: swing delays every second step, key transposes, age sets velocity", () => {
  const two = gridOf(16, [[0, 11], [1, 11]]);
  const s = { scale: "majpent", voice: "glass", bpm: 96, bass: false, key: 3, swing: 50, evolveEvery: 0 };
  const m = readMidi(C.renderMidi(two, new Uint16Array(two.length), 16, s, 1));
  eq(m.notes[0].t, 0, "first step on the beat:");
  eq(m.notes[1].t, 24 + 6, "second step late by a quarter of a step:");
  eq(m.notes[0].note, 51, "C3 moved to D#3:");
  const age = new Uint16Array(two.length); age[11 * 16 + 1] = 9;
  const aged = readMidi(C.renderMidi(two, age, 16, s, 1));
  eq(aged.notes[0].vel > aged.notes[1].vel, true, "older cell is quieter:");
});
test("MIDI export: an empty grid gives a valid file with no notes", () => {
  const m = readMidi(C.renderMidi(new Uint8Array(16 * R), new Uint16Array(16 * R), 16, C.sanitize({}), 4));
  eq(m.notes.length, 0);
});

print("\n" + passed + " passed, " + failed + " failed");
if (failed) print("TESTS FAILED");
