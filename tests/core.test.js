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
    const s = { scale, voice: C.VOICES[Math.floor(rnd() * 3)], evolveEvery, bpm: 50 + Math.floor(rnd() * 131), bass: rnd() < 0.5 };
    const code = C.encode(g, cols, s);
    if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("unsafe character in " + code);
    const d = C.decode("#" + code);
    eq(d.cols, cols);
    eq(same(d.grid, g), true, "grid " + cols + ":");
    for (const k of ["scale", "voice", "evolveEvery", "bpm", "bass"]) eq(d.settings[k], s[k], k + ":");
  }
});
test("v1 codes from the first version still load", () => {
  const g = gridOf(16, [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
  const v2 = C.encode(g, 16, { scale: "dorian", voice: "reed", evolveEvery: 2, bpm: 96, bass: true });
  const v1 = "v1" + v2.slice(3);
  const d = C.decode(v1);
  eq(d.cols, 16); eq(same(d.grid, g), true); eq(d.settings.scale, "dorian");
});
test("bad codes are rejected", () => {
  const good = C.encode(new Uint8Array(16 * R), 16, C.DEFAULTS);
  for (const bad of ["", "v2", good + "A", good.slice(0, -1), "v3" + good.slice(2), good.replace(/.$/, "!"), "v2N" + good.slice(3), null, 42]) {
    eq(C.decode(bad), null, JSON.stringify(bad) + ":");
  }
});
test("sanitize repairs bad settings and keeps good ones", () => {
  const s = C.sanitize({ scale: "nope", voice: 3, evolveEvery: 7, bpm: 9999, volume: "loud", reseed: false, bass: undefined });
  eq(s.scale, "majpent"); eq(s.voice, "glass"); eq(s.evolveEvery, 1); eq(s.bpm, 180); eq(s.volume, 70); eq(s.reseed, false); eq(s.bass, true);
  const z = C.sanitize({ scale: "whole", voice: "pluck", evolveEvery: 0, bpm: 50, volume: 0 });
  eq(z.volume, 0, "volume 0 stays 0:"); eq(z.evolveEvery, 0); eq(z.scale, "whole");
});
test("rows map to scale notes, lowest at the bottom", () => {
  eq(C.midiForRow(R - 1, "majpent"), 48, "C3:");
  eq(C.midiForRow(0, "majpent"), 74, "D5:");
  eq(C.midiForRow(R - 1, "missing"), 48, "unknown scale falls back:");
});

print("\n" + passed + " passed, " + failed + " failed");
if (failed) print("TESTS FAILED");
