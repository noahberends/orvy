(() => {
  "use strict";

  const { ROWS, STEP_OPTIONS } = OrvyCore;
  let COLS = 16, N = COLS * ROWS;

  const MOODS = {
    bright: { scale: "majpent", voice: "glass", bpm: 96 },
    mellow: { scale: "dorian", voice: "reed", bpm: 84 },
    sharp: { scale: "hirajoshi", voice: "pluck", bpm: 108 },
    hazy: { scale: "whole", voice: "glass", bpm: 72 },
  };
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const MAX_VOICES = 4;
  const MAX_HISTORY = 300;
  // Filled in by build.py: "embed" for the single-file page, "site" for self-hosting.
  const TARGET = "{{TARGET}}";
  const SHARE_BASE = "{{SHARE_BASE}}" || location.origin + location.pathname;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = id => document.getElementById(id);

  const KEYS = { state: "orvy-state", tapes: "orvy-tapes", sections: "orvy-sections", applied: "orvy-applied-link", coached: "orvy-coached" };
  const OLD_KEYS = { state: "glider-choir-v1", tapes: "glider-choir-slots", sections: "glider-choir-sections", applied: "glider-choir-applied-share" };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  // Carry saved work over from the earlier storage keys.
  for (const k in OLD_KEYS) {
    if (store.get(KEYS[k]) === null) { const v = store.get(OLD_KEYS[k]); if (v !== null) store.set(KEYS[k], v); }
  }

  // ---------- State ----------
  let grid, age, doomed, strike, born, ghost;
  function allocate() {
    N = COLS * ROWS;
    doomed = new Uint8Array(N);
    strike = new Float64Array(N);
    born = new Float64Array(N);
    ghost = new Float32Array(N);
  }
  allocate();
  grid = new Uint8Array(N);
  age = new Uint16Array(N);

  const settings = { bpm: 96, volume: 70, evolveEvery: 1, reseed: true, scale: "majpent", voice: "glass", bass: true, cols: 16 };
  let generation = 0;
  let history = [], cursor = -1, handState = null;
  let seen = new Map(), settledFor = 0;
  let stateInfo = { kind: "evolving", text: "Evolving" };
  let holding = false;
  const USER_EDITS = new Set(["paint", "seed", "load", "restore", "stamp", "length"]);

  const idx = (c, r) => r * COLS + c;
  const wrapC = c => (c + COLS) % COLS, wrapR = r => (r + ROWS) % ROWS;
  const countLit = g2 => { let p = 0; for (let i = 0; i < g2.length; i++) p += g2[i]; return p; };
  const population = () => countLit(grid);
  const key = () => grid.join("");
  const computeDoomed = () => OrvyCore.markDoomed(grid, COLS, doomed);
  // Ghost trails for cells that go out, pop-in for cells that light.
  function replaceGrid(next, nextAge) {
    const now = performance.now();
    for (let i = 0; i < N; i++) {
      if (grid[i] && !next[i]) ghost[i] = 1;
      if (!grid[i] && next[i]) { born[i] = now; ghost[i] = 0; }
    }
    grid = next;
    age = nextAge || new Uint16Array(N);
  }

  // ---------- Grid length ----------
  const remap = OrvyCore.remap;
  // Switches the live grid to n steps. History entries keep their own length, so nothing is lost for good.
  function applyCols(n) {
    if (n === COLS || !STEP_OPTIONS.includes(n)) return false;
    grid = remap(grid, COLS, n, Uint8Array);
    age = remap(age, COLS, n, Uint16Array);
    COLS = n; settings.cols = n;
    allocate();
    cur.c = Math.min(cur.c, COLS - 1);
    resumeStep %= COLS; step %= COLS;
    visualQueue.length = 0; visualStep = -1; litRows = new Set(); hoverCell = -1;
    computeDoomed();
    syncControls();
    resize();
    return true;
  }
  function changeLength(n) {
    const before = history[cursor];
    if (!applyCols(n)) return;
    commit("length");
    toast(`${n} steps`, before);
  }

  // ---------- History ----------
  const SOUND_KEYS = ["bpm", "scale", "voice", "evolveEvery", "bass"];
  function snapshot(label) {
    const sound = {};
    SOUND_KEYS.forEach(k => { sound[k] = settings[k]; });
    return { grid: grid.slice(), age: age.slice(), cols: COLS, generation, pop: population(), label, sound };
  }
  function commit(label) {
    history = history.slice(0, cursor + 1);
    history.push(snapshot(label));
    if (history.length > MAX_HISTORY) history.shift();
    cursor = history.length - 1;
    if (label !== "gen") {
      // The restore point is the last pattern a person made; automatic reseeds don't move it.
      if (label !== "reseed" && label !== "length") handState = history[cursor];
      seen = new Map(); settledFor = 0;
      stateInfo = population() ? { kind: "evolving", text: "Evolving" } : { kind: "extinct", text: "Empty" };
      seen.set(key(), generation);
    }
    if (USER_EDITS.has(label)) markEdit();
    computeDoomed();
    updateStatus();
    save();
    requestRender();
  }
  function goTo(i) {
    if (i < 0 || i >= history.length || i === cursor) return;
    const h = history[i];
    // Moving across a tape or link load also brings back the tempo and sound from that side of it.
    const lo = Math.min(cursor, i) + 1, hi = Math.max(cursor, i);
    let crossesLoad = false;
    for (let j = lo; j <= hi; j++) if (history[j].label === "load") crossesLoad = true;
    if (crossesLoad && h.sound) {
      Object.assign(settings, h.sound);
      syncControls(); applyAudioSettings(); buildBg();
    }
    applyCols(h.cols);
    replaceGrid(h.grid.slice(), h.age.slice());
    generation = h.generation;
    cursor = i;
    seen = new Map(); settledFor = 0; seen.set(key(), generation);
    stateInfo = population() ? { kind: "evolving", text: "Evolving" } : { kind: "extinct", text: "Empty" };
    markEdit();
    computeDoomed();
    updateStatus();
    save();
    requestRender();
  }
  function back() {
    if (cursor > 0) { goTo(cursor - 1); announce(`Generation ${generation}, ${population()} lit`); }
    else toast("Oldest step");
  }
  function forward(allowEvolve) {
    if (cursor < history.length - 1) { goTo(cursor + 1); announce(`Generation ${generation}, ${population()} lit`); }
    else if (allowEvolve) { evolve(); announce(`Generation ${generation}, ${population()} lit, ${stateInfo.text}`); }
  }
  const sameGrid = g2 => { if (g2.length !== grid.length) return false; for (let i = 0; i < N; i++) if (g2[i] !== grid[i]) return false; return true; };
  function restoreHand() {
    if (!handState || sameGrid(handState.grid)) return;
    const before = history[cursor];
    applyCols(handState.cols);
    replaceGrid(handState.grid.slice(), new Uint16Array(N));
    generation = handState.generation;
    commit("restore");
    toast("Pattern restored", before);
  }

  // ---------- Life ----------
  function evolve() {
    const nextGen = OrvyCore.lifeStep(grid, age, COLS);
    replaceGrid(nextGen.grid, nextGen.age);
    generation++;
    commit("gen");
    const info = classify();
    stateInfo = info;
    seen.set(key(), generation);
    if (seen.size > 200) seen.delete(seen.keys().next().value);
    settledFor = info.settled ? settledFor + 1 : 0;
    updateStatus();
    // Repeating patterns get a few cycles before reseeding; an empty grid reseeds sooner.
    if (settings.reseed && (info.kind === "extinct" ? settledFor >= 2 : settledFor >= 6)) seed("random", { auto: true });
  }
  function classify() {
    if (population() === 0) return { kind: "extinct", text: "Empty", settled: true };
    const k = key();
    if (seen.has(k)) {
      const period = generation - seen.get(k);
      if (period === 1) return { kind: "still", text: "Still", settled: true };
      return { kind: "osc", text: `Repeats every ${period}`, settled: true };
    }
    return { kind: "evolving", text: "Evolving", settled: false };
  }

  // ---------- Patterns ----------
  const SCENES = {
    gliders: [[".O.", "..O", "OOO", 1, 1], ["OOO", "O..", ".O.", 9, 6]],
    osc: [[".OOO", "OOO.", 1, 2], ["OO..", "OO..", "..OO", "..OO", 7, 1], ["OOO", 12, 8], ["O", "O", "O", 3, 7]],
  };
  const SCENE_TOASTS = { gliders: "Gliders", osc: "Oscillators", random: "Random grid", clear: "Cleared" };
  const STAMPS = {
    glider: { name: "glider", rows: [".O.", "..O", "OOO"] },
    lwss: { name: "spaceship", rows: [".O..O", "O....", "O...O", "OOOO."] },
    rpent: { name: "R-pentomino", rows: [".OO", "OO.", ".O."] },
    blinker: { name: "blinker", rows: ["OOO"] },
    toad: { name: "toad", rows: [".OOO", "OOO."] },
    beacon: { name: "beacon", rows: ["OO..", "OO..", "..OO", "..OO"] },
  };
  function seed(name, opts = {}) {
    const before = history[cursor];
    const next = new Uint8Array(N);
    if (name === "random") {
      for (let i = 0; i < N; i++) next[i] = Math.random() < 0.3 ? 1 : 0;
    } else if (SCENES[name]) {
      SCENES[name].forEach(spec => {
        const r0 = spec[spec.length - 1], c0 = spec[spec.length - 2];
        spec.slice(0, -2).forEach((line, r) => [...line].forEach((ch, c) => {
          if (ch === "O") next[idx((c0 + c) % COLS, (r0 + r) % ROWS)] = 1;
        }));
      });
    }
    replaceGrid(next);
    generation = 0;
    commit(opts.auto ? "reseed" : "seed");
    if (opts.silent || !before) return;
    toast(opts.auto ? "Settled, reseeded" : SCENE_TOASTS[name] || "New grid", before);
  }

  let stamp = null, hoverCell = -1;
  const cellsOf = rows => { const out = []; rows.forEach((line, y) => [...line].forEach((ch, x) => { if (ch === "O") out.push([x, y]); })); return out; };
  function rotateStamp(dir) {
    if (!stamp) return;
    const rc = stamp.cells.map(([x, y]) => dir > 0 ? [-y, x] : [y, -x]);
    const mx = Math.min(...rc.map(p => p[0])), my = Math.min(...rc.map(p => p[1]));
    stamp.cells = rc.map(([x, y]) => [x - mx, y - my]);
    requestRender();
  }
  function stampTargets(i) {
    const c0 = i % COLS, r0 = Math.floor(i / COLS);
    const w = Math.max(...stamp.cells.map(p => p[0])) + 1, h = Math.max(...stamp.cells.map(p => p[1])) + 1;
    return stamp.cells.map(([x, y]) => idx(wrapC(c0 + x - (w >> 1)), wrapR(r0 + y - (h >> 1))));
  }
  function setStamp(id) {
    stamp = id && (!stamp || stamp.id !== id) ? { id, cells: cellsOf(STAMPS[id].rows) } : null;
    document.querySelectorAll("[data-stamp]").forEach(b => b.setAttribute("aria-pressed", String(!!stamp && b.dataset.stamp === stamp.id)));
    $("stampChip").hidden = !stamp;
    document.body.classList.toggle("stamping", !!stamp);
    if (stamp) {
      $("stampText").textContent = `Stamp: ${STAMPS[id].name}`;
      closeSheet();
      announce(`Stamp ${STAMPS[id].name}. Click the grid to place it.`);
    }
    requestRender();
  }
  function placeStamp(i) {
    if (!stamp || i < 0) return;
    let changed = false;
    stampTargets(i).forEach(j => { changed = setCell(j, 1, false) || changed; });
    if (!changed) return;
    commit("stamp");
    if (wakeAudio()) playNote(mtof(midiForRow(Math.floor(i / COLS))), actx.currentTime + 0.005, panFor(i % COLS), 0.16, 1, 1);
  }
  function drawStampIcons() {
    document.querySelectorAll("[data-stamp]").forEach(b => {
      const cv = b.querySelector("canvas");
      const cells = cellsOf(STAMPS[b.dataset.stamp].rows);
      const w = Math.max(...cells.map(p => p[0])) + 1, h = Math.max(...cells.map(p => p[1])) + 1;
      const size = 64, unit = Math.min(14, Math.floor(52 / Math.max(w, h))), ox = (size - w * unit) / 2, oy = (size - h * unit) / 2;
      cv.width = cv.height = size;
      const x = cv.getContext("2d");
      x.strokeStyle = "#19f0ff"; x.lineWidth = 3;
      cells.forEach(([cx, cy]) => { x.strokeRect(ox + cx * unit + 2, oy + cy * unit + 2, unit - 4, unit - 4); });
    });
  }

  // ---------- Links ----------
  const encodeState = () => OrvyCore.encode(grid, COLS, settings);
  const decodeState = OrvyCore.decode;
  function applyDecoded(dec, label) {
    applyCols(dec.cols);
    Object.assign(settings, dec.settings);
    syncControls(); applyAudioSettings(); buildBg();
    replaceGrid(dec.grid.slice());
    generation = 0;
    commit(label);
  }
  // A link applies once; reloading afterwards keeps your own edits.
  function linkedPattern() {
    const code = location.hash.replace(/^#/, "");
    const d = decodeState(code);
    if (!d || store.get(KEYS.applied) === code) return null;
    store.set(KEYS.applied, code);
    return d;
  }

  // ---------- Audio ----------
  let actx = null, master, comp, delay, delayFb, delayTone, wet;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let silentAudio = null;
  // iPhones mute web audio when the ringer switch is on silent unless the page declares itself a player.
  function claimPlaybackSession() {
    try { if (navigator.audioSession) { navigator.audioSession.type = "playback"; return; } } catch (e) {}
    if (!isIOS || silentAudio) return;
    // Older iOS: a looping silent media element moves the page into the playback category.
    try {
      const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
      const str = (o, t) => [...t].forEach((ch, k) => v.setUint8(o + k, ch.charCodeAt(0)));
      str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
      v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, "data"); v.setUint32(40, n, true);
      for (let k = 0; k < n; k++) v.setUint8(44 + k, 128);
      silentAudio = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
      silentAudio.loop = true;
      silentAudio.setAttribute("playsinline", "");
      silentAudio.play().catch(() => {});
    } catch (e) {}
  }
  function initAudio() {
    if (actx) return true;
    if (!AudioCtor) return false;
    claimPlaybackSession();
    actx = new AudioCtor();
    // A phone call or another app can interrupt audio; pick up again when the page is back in front.
    actx.onstatechange = () => { if (playing && actx.state !== "running" && !document.hidden) actx.resume().catch(() => {}); };
    master = actx.createGain();
    comp = actx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    delay = actx.createDelay(2);
    delayFb = actx.createGain(); delayFb.gain.value = 0.33;
    delayTone = actx.createBiquadFilter(); delayTone.type = "lowpass"; delayTone.frequency.value = 2200;
    wet = actx.createGain(); wet.gain.value = 0.28;
    master.connect(comp);
    master.connect(delay);
    delay.connect(delayTone); delayTone.connect(delayFb); delayFb.connect(delay);
    delayTone.connect(wet); wet.connect(comp);
    comp.connect(actx.destination);
    applyAudioSettings();
    return true;
  }
  const resumeIfInterrupted = () => { if (playing && actx && actx.state !== "running") actx.resume().catch(() => {}); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeIfInterrupted(); });
  document.addEventListener("pointerdown", resumeIfInterrupted);
  function applyAudioSettings() {
    if (!actx) return;
    master.gain.setTargetAtTime((settings.volume / 100) ** 1.5 * 0.9, actx.currentTime, 0.03);
    delay.delayTime.setTargetAtTime(stepDur() * 3, actx.currentTime, 0.05);
  }
  const stepDur = () => 60 / settings.bpm / 4;

  const midiForRow = r => OrvyCore.midiForRow(r, settings.scale);
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const noteName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  const panFor = s => (s / (COLS - 1)) * 1.4 - 0.7;

  // bright (0..1) opens the tone filter; decayMul < 1 shortens the note.
  function playNote(freq, t, pan, level, bright = 0.7, decayMul = 1) {
    const out = actx.createGain();
    const tone = actx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = Math.min(16000, 300 + freq * (1.5 + bright * 10));
    out.connect(tone);
    const p = actx.createStereoPanner ? actx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; tone.connect(p); p.connect(master); } else tone.connect(master);
    let decay;
    if (settings.voice === "glass") {
      decay = 1.4 * decayMul;
      const o1 = actx.createOscillator(); o1.type = "sine"; o1.frequency.value = freq;
      const o2 = actx.createOscillator(); o2.type = "sine"; o2.frequency.value = freq * 2.003;
      const g2 = actx.createGain(); g2.gain.value = 0.12 + bright * 0.25;
      o1.connect(out); o2.connect(g2); g2.connect(out);
      [o1, o2].forEach(o => { o.start(t); o.stop(t + decay + 0.05); });
    } else if (settings.voice === "reed") {
      decay = 0.8 * decayMul;
      const o = actx.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
      const o2 = actx.createOscillator(); o2.type = "square"; o2.frequency.value = freq * 0.5;
      const g2 = actx.createGain(); g2.gain.value = 0.12;
      o.connect(out); o2.connect(g2); g2.connect(out);
      [o, o2].forEach(x => { x.start(t); x.stop(t + decay + 0.05); });
    } else {
      decay = 0.6 * decayMul;
      const o = actx.createOscillator(); o.type = "sawtooth"; o.frequency.value = freq;
      const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 4;
      lp.frequency.setValueAtTime(Math.min(9000, freq * (4 + bright * 8)), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 0.9), t + 0.25);
      o.connect(lp); lp.connect(out);
      o.start(t); o.stop(t + decay + 0.05);
    }
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  }
  function playBass(freq, t, dur) {
    const out = actx.createGain();
    const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420;
    const o = actx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
    const o2 = actx.createOscillator(); o2.type = "triangle"; o2.frequency.value = freq;
    const g2 = actx.createGain(); g2.gain.value = 0.35;
    o.connect(out); o2.connect(g2); g2.connect(out); out.connect(lp); lp.connect(comp);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.14 * (settings.volume / 100) ** 1.5), t + 0.12);
    out.gain.setTargetAtTime(0.0001, t + dur * 0.8, dur * 0.06);
    [o, o2].forEach(x => { x.start(t); x.stop(t + dur + 0.1); });
  }
  // Level, tone and on-screen brightness by age: 0 is newest.
  const ageAlpha = a => a === 0 ? 1 : a < 3 ? 0.86 : a < 6 ? 0.7 : 0.56;
  function voicing(i) {
    const a = age[i];
    if (a === 0) return { vel: 1, bright: 1, alpha: 1 };
    if (a < 3) return { vel: 0.78, bright: 0.65, alpha: 0.86 };
    if (a < 6) return { vel: 0.6, bright: 0.4, alpha: 0.7 };
    return { vel: 0.48, bright: 0.22, alpha: 0.56 };
  }

  // ---------- Transport ----------
  let playing = false, timer = null, nextTime = 0, step = 0, bar = 0, resumeStep = 0, coachTimer = 0;
  let lastEditBar = -99;
  const visualQueue = [];
  let visualStep = -1, litRows = new Set();

  // An edit made while playing skips the next evolution so the change is heard at least once.
  function markEdit() {
    if (!playing) return;
    lastEditBar = bar;
    const E = settings.evolveEvery;
    if (E > 0 && (bar + 1) % E === 0) setHolding(true);
  }
  function setHolding(v) { if (holding !== v) { holding = v; updateStatus(); } }

  function scheduleStep(s, t) {
    if (s === 0) {
      const due = bar > 0 && settings.evolveEvery > 0 && bar % settings.evolveEvery === 0;
      const held = lastEditBar >= bar - 1;
      if (due && !held) evolve();
      setHolding(due && held);
      if (settings.bass) {
        let low = -1;
        for (let r = ROWS - 1; r >= 0 && low < 0; r--) for (let c = 0; c < COLS; c++) if (grid[idx(c, r)]) { low = r; break; }
        if (low >= 0 && settings.volume > 0) playBass(mtof(midiForRow(low) - 12), t, stepDur() * COLS);
      }
    }
    const cands = [];
    for (let r = 0; r < ROWS; r++) { const i = idx(s, r); if (grid[i]) cands.push(i); }
    cands.sort((a, b) => (age[a] - age[b]) || (doomed[b] - doomed[a]));
    const chosen = cands.slice(0, MAX_VOICES);
    const level = 0.24 / Math.sqrt(Math.max(1, chosen.length));
    chosen.forEach(i => {
      const v = voicing(i);
      const decayMul = doomed[i] ? 0.28 : (age[i] >= 6 ? 1.25 : 1);
      playNote(mtof(midiForRow(Math.floor(i / COLS))), t, panFor(s), level * v.vel, v.bright, decayMul);
    });
    visualQueue.push({ s, t, cells: chosen });
  }
  function scheduler() {
    // Background tabs throttle timers: schedule further ahead there, and skip forward after a stall.
    const ahead = document.hidden ? 1.2 : 0.1;
    if (nextTime < actx.currentTime - 0.05) nextTime = actx.currentTime + 0.03;
    while (nextTime < actx.currentTime + ahead) {
      scheduleStep(step, nextTime);
      nextTime += stepDur();
      step = (step + 1) % COLS;
      if (step === 0) bar++;
    }
  }
  let starting = false, suspendTimer = 0;
  // Let reverb and delay tails ring out, then suspend the audio engine to save power while paused.
  function armSuspend() {
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => { if (!playing && actx && actx.state === "running") actx.suspend(); }, 5000);
  }
  function wakeAudio() {
    if (!actx) return false;
    if (actx.state === "suspended") actx.resume();
    if (!playing) armSuspend();
    return actx.state !== "closed";
  }
  async function togglePlay() {
    if (starting) return;
    if (!initAudio()) { notice("This browser can't play sound. You can still draw and step through generations."); return; }
    if (playing) {
      playing = false;
      clearInterval(timer); timer = null;
      resumeStep = visualStep >= 0 ? (visualStep + 1) % COLS : step;
      visualQueue.length = 0;
      visualStep = -1; litRows = new Set();
      setHolding(false);
      if ($("coach").hidden) clearTimeout(coachTimer);
      armSuspend();
    } else {
      clearTimeout(suspendTimer);
      if (actx.state !== "running") {
        starting = true;
        try { await actx.resume(); } catch (e) {}
        starting = false;
      }
      if (playing) return;
      if (silentAudio && silentAudio.paused) silentAudio.play().catch(() => {});
      playing = true;
      step = resumeStep;
      nextTime = actx.currentTime + 0.06;
      scheduler();
      clearInterval(timer);
      timer = setInterval(scheduler, 25);
      maybeCoach();
    }
    setSign(playing);
    updatePlayButton();
    requestRender();
  }
  function rewindPlayhead() {
    resumeStep = 0;
    if (playing) { step = 0; visualQueue.length = 0; nextTime = actx.currentTime + 0.03; }
    announce("Playhead at step 1");
    requestRender();
  }
  // The name lights up while sound is playing.
  let igniteTimer = 0;
  function setSign(on) {
    const b = document.body;
    if (on && !b.classList.contains("lit")) {
      b.classList.add("igniting");
      clearTimeout(igniteTimer);
      igniteTimer = setTimeout(() => b.classList.remove("igniting"), 750);
    }
    b.classList.toggle("lit", on);
  }

  // ---------- Geometry ----------
  const canvas = $("grid");
  const g = canvas.getContext("2d");
  const GUTTER = 38, GTOP = 22;
  let cell = 30, dpr = 1, vertical = false, cw = 0, ch = 0, lastLayout = "", lastSpriteKey = "";

  // Wide: steps run left to right. Narrow: steps run top to bottom, low notes on the left.
  const cellX = (c, r) => vertical ? (ROWS - 1 - r) * cell : GUTTER + c * cell;
  const cellY = (c, r) => vertical ? GTOP + c * cell : r * cell;
  const cellXY = (c, r) => [cellX(c, r), cellY(c, r)];
  const stepRect = (s, n = 1) => vertical ? [0, GTOP + s * cell, ROWS * cell, cell * n] : [GUTTER + s * cell, 0, cell * n, ROWS * cell];
  function cellAtXY(x, y) {
    let c, r;
    if (vertical) { r = ROWS - 1 - Math.floor(x / cell); c = Math.floor((y - GTOP) / cell); }
    else { c = Math.floor((x - GUTTER) / cell); r = Math.floor(y / cell); }
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
    return idx(c, r);
  }
  function resize() {
    const board = $("board"), st = getComputedStyle(board);
    const w = board.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight);
    const wasVertical = vertical;
    vertical = w < 520;
    if (vertical) {
      cell = Math.max(16, Math.min(44, Math.floor(w / ROWS)));
      cw = ROWS * cell; ch = GTOP + COLS * cell;
    } else {
      cell = Math.max(14, Math.min(48, Math.floor((w - GUTTER) / COLS)));
      cw = GUTTER + cell * COLS; ch = cell * ROWS;
    }
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const layout = [cw, ch, dpr, COLS, vertical].join();
    if (layout === lastLayout) return;
    lastLayout = layout;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const spriteKey = cell + "/" + dpr;
    if (spriteKey !== lastSpriteKey) { lastSpriteKey = spriteKey; buildSprites(); resizeSpark(); }
    buildBg();
    if (wasVertical !== vertical) updateHints();
    requestRender();
  }

  // ---------- Neon sprites ----------
  // Each tube is drawn once per row at two strengths, resting and struck; frames only stamp and cross-fade them.
  const hueFor = r => 325 - ((ROWS - 1 - r) / (ROWS - 1)) * 140;
  let restSprites = [], hitSprites = [], ghostSprites = [];
  const bgLayer = document.createElement("canvas");

  function roundRect(ctx, x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
  function makeSprite(h, hit, outlineOnly) {
    const k = cell / 30;
    const blur = (hit ? 30 : 9) * k;
    const M = Math.ceil(blur * 1.1 + 3);
    const S = cell + M * 2;
    const cv = document.createElement("canvas");
    cv.width = cv.height = Math.ceil(S * dpr);
    const x = cv.getContext("2d");
    x.scale(dpr, dpr);
    const pad = Math.max(3, Math.round(cell * 0.14)), rad = Math.max(3, cell * 0.24), tube = Math.max(1.5, cell * 0.075);
    roundRect(x, M + pad, M + pad, cell - pad * 2, cell - pad * 2, rad);
    if (!outlineOnly) { x.fillStyle = `hsla(${h}, 100%, ${hit ? 75 : 55}%, ${hit ? 0.7 : 0.14})`; x.fill(); }
    x.globalCompositeOperation = "lighter";
    x.shadowColor = `hsl(${h} 100% 58%)`;
    x.shadowBlur = blur * dpr;
    x.lineWidth = tube;
    x.strokeStyle = `hsl(${h} 100% ${hit ? 75 : 60}%)`;
    x.stroke();
    if (!outlineOnly) {
      x.shadowBlur = 0;
      x.lineWidth = Math.max(0.75, tube * 0.4);
      x.strokeStyle = `hsla(${h}, 100%, 92%, ${hit ? 1 : 0.75})`;
      x.stroke();
    }
    return { img: cv, S };
  }
  function buildSprites() {
    restSprites = []; hitSprites = []; ghostSprites = [];
    for (let r = 0; r < ROWS; r++) {
      const h = hueFor(r);
      restSprites.push(makeSprite(h, false, false));
      hitSprites.push(makeSprite(h, true, false));
      ghostSprites.push(makeSprite(h, false, true));
    }
  }
  function buildBg() {
    bgLayer.width = canvas.width; bgLayer.height = canvas.height;
    const b = bgLayer.getContext("2d");
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let c = 0; c < COLS; c += 4) {
      const [x, y, w, h] = stepRect(c, Math.min(4, COLS - c));
      if ((c / 4) % 2 === 0) { b.fillStyle = "rgba(255,43,214,0.045)"; b.fillRect(x, y, w, h); }
      if (c) { b.fillStyle = "rgba(255,43,214,0.16)"; vertical ? b.fillRect(x, y - 0.5, w, 1) : b.fillRect(x - 0.5, y, 1, h); }
    }
    for (let r = 0; r < ROWS; r++) {
      b.fillStyle = `hsla(${hueFor(r)}, 80%, 65%, 0.2)`;
      for (let c = 0; c < COLS; c++) {
        const [x, y] = cellXY(c, r);
        b.beginPath(); b.arc(x + cell / 2, y + cell / 2, Math.max(1.1, cell * 0.05), 0, Math.PI * 2); b.fill();
      }
      drawLabel(b, r, false);
    }
  }
  function drawLabel(ctx, r, lit) {
    ctx.font = `600 ${Math.max(9, Math.min(vertical ? 11 : 12, cell * (vertical ? 0.36 : 0.4)))}px "Chakra Petch", sans-serif`;
    ctx.textBaseline = "middle";
    const name = noteName(midiForRow(r));
    if (lit) { ctx.shadowColor = `hsl(${hueFor(r)} 100% 60%)`; ctx.shadowBlur = 10; }
    ctx.fillStyle = lit ? `hsl(${hueFor(r)} 100% 82%)` : "#8072ab";
    if (vertical) { ctx.textAlign = "center"; ctx.fillText(name, (ROWS - 1 - r) * cell + cell / 2, GTOP / 2); }
    else { ctx.textAlign = "left"; ctx.fillText(name, 2, r * cell + cell / 2); }
    ctx.shadowBlur = 0;
  }

  // ---------- Render loop (idles when nothing moves) ----------
  let rafId = 0, lastFrame = performance.now();
  const WAKE = ["rgba(25,240,255,0.13)", "rgba(25,240,255,0.06)", "rgba(25,240,255,0.025)"];
  const requestRender = () => { if (!rafId) rafId = requestAnimationFrame(frame); };
  function frame(now) {
    rafId = 0;
    const animating = draw(now);
    if (animating || playing) requestRender();
  }
  function stampSprite(sp, x, y, scale, alpha) {
    const size = sp.S * scale;
    g.globalAlpha = alpha;
    g.drawImage(sp.img, x + cell / 2 - size / 2, y + cell / 2 - size / 2, size, size);
  }
  function draw(now) {
    const dt = Math.min(100, now - lastFrame); lastFrame = now;
    let animating = false;
    if (playing && actx) {
      while (visualQueue.length && visualQueue[0].t <= actx.currentTime) {
        const ev = visualQueue.shift();
        visualStep = ev.s;
        litRows = new Set();
        ev.cells.forEach(i => { if (grid[i]) { strike[i] = now; litRows.add(Math.floor(i / COLS)); } });
      }
    }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    g.clearRect(0, 0, cw, ch);
    g.drawImage(bgLayer, 0, 0, cw, ch);
    litRows.forEach(r => drawLabel(g, r, true));

    if (visualStep >= 0) {
      for (let k = 2; k >= 0; k--) {
        const [x, y, w, h] = stepRect(wrapC(visualStep - k));
        g.fillStyle = WAKE[k];
        g.fillRect(x, y, w, h);
      }
      const [x, y, w, h] = stepRect(visualStep);
      g.globalCompositeOperation = "lighter";
      g.shadowColor = "#19f0ff"; g.shadowBlur = 16;
      g.fillStyle = "rgba(25,240,255,0.9)";
      vertical ? g.fillRect(x, y + h - 2, w, 2) : g.fillRect(x + w - 2, y, 2, h);
      g.shadowBlur = 0;
      g.fillStyle = "rgba(220,255,255,0.9)";
      vertical ? g.fillRect(x, y + h - 1.5, w, 1) : g.fillRect(x + w - 1.5, y, 1, h);
    } else if (!playing && resumeStep > 0) {
      const [x, y, w, h] = stepRect(resumeStep);
      g.fillStyle = "rgba(25,240,255,0.35)";
      vertical ? g.fillRect(x, y - 1, w, 2) : g.fillRect(x - 1, y, 2, h);
    }

    g.globalCompositeOperation = "lighter";
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const i = idx(c, r);
      if (!grid[i] && ghost[i] <= 0.01) continue;
      const x = cellX(c, r), y = cellY(c, r);
      if (!grid[i]) {
        if (ghost[i] > 0.01) {
          stampSprite(ghostSprites[r], x, y, 1, ghost[i] * 0.5);
          ghost[i] *= Math.pow(0.1, dt / 1000);
          animating = true;
        }
        continue;
      }
      const since = now - strike[i];
      const glow = since < 600 ? Math.pow(1 - since / 600, 1.6) : 0;
      if (glow > 0) animating = true;
      let s = 1 + glow * 0.1;
      if (!reduceMotion) {
        const a = now - born[i];
        if (a < 260) { s *= 0.35 + 0.65 * (a / 260); animating = true; }
      }
      let alpha = Math.min(1, ageAlpha(age[i]) + glow * 0.4);
      // Cells about to go out flicker like a failing tube during playback.
      if (playing && doomed[i] && !reduceMotion && glow < 0.3) {
        if (Math.sin(now * 0.031 + i * 7.3) + Math.sin(now * 0.017 + i) > 1.0) alpha *= 0.3;
      }
      stampSprite(restSprites[r], x, y, s, alpha);
      if (glow > 0.02) stampSprite(hitSprites[r], x, y, s, glow);
    }

    const target = showCursor ? idx(cur.c, cur.r) : hoverCell;
    if (stamp && target >= 0) {
      stampTargets(target).forEach(j => {
        const r = Math.floor(j / COLS), [x, y] = cellXY(j % COLS, r);
        stampSprite(restSprites[r], x, y, 1, 0.45);
        g.globalAlpha = 1;
        g.strokeStyle = "rgba(198,255,61,0.75)"; g.lineWidth = 1; g.setLineDash([3, 3]);
        roundRect(g, x + 2, y + 2, cell - 4, cell - 4, Math.max(3, cell * 0.22));
        g.stroke(); g.setLineDash([]);
      });
    }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;

    if (showCursor) {
      const [x, y] = cellXY(cur.c, cur.r);
      g.strokeStyle = "#c6ff3d"; g.lineWidth = 2;
      roundRect(g, x + 1.5, y + 1.5, cell - 3, cell - 3, Math.max(3, cell * 0.24));
      g.stroke();
    }
    return animating;
  }

  // ---------- Population line, since the last edit ----------
  const spark = $("spark");
  const sg = spark.getContext("2d");
  function resizeSpark() {
    spark.width = 72 * dpr; spark.height = 18 * dpr;
    sg.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (history.length) drawSpark();
  }
  function drawSpark() {
    const w = 72, h = 18;
    sg.clearRect(0, 0, w, h);
    const from = Math.max(0, history.indexOf(handState), cursor - 127);
    const data = history.slice(from, cursor + 1).map(e => e.pop);
    if (data.length < 2) { sg.fillStyle = "rgba(157,146,189,0.4)"; sg.fillRect(0, h - 2, w, 1); return; }
    const max = Math.max(4, ...data);
    const X = i => (i / (data.length - 1)) * (w - 4) + 2;
    const Y = v => h - 2 - (v / max) * (h - 5);
    sg.beginPath();
    data.forEach((v, i) => i ? sg.lineTo(X(i), Y(v)) : sg.moveTo(X(i), Y(v)));
    sg.strokeStyle = "#19f0ff"; sg.lineWidth = 1.5; sg.lineJoin = "round"; sg.stroke();
    sg.fillStyle = "#e3feff"; sg.beginPath(); sg.arc(X(data.length - 1), Y(data[data.length - 1]), 2, 0, Math.PI * 2); sg.fill();
  }

  // ---------- Toasts ----------
  let toastTimer = 0, toastUndoEntry = null;
  function toast(text, undoTo) {
    const t = $("toast");
    $("toastText").textContent = text;
    toastUndoEntry = undoTo || null;
    $("toastUndo").hidden = !undoTo;
    t.classList.toggle("actionable", !!undoTo);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove("show", "actionable"); toastUndoEntry = null; }, undoTo ? 6000 : 2200);
  }
  $("toastUndo").addEventListener("click", () => {
    const i = history.indexOf(toastUndoEntry);
    if (i >= 0) { goTo(i); toast("Undone"); } else toast("Can't undo that now");
  });
  function announce(text) { const s = $("sr"); s.textContent = ""; setTimeout(() => { s.textContent = text; }, 30); }

  // ---------- Status and controls ----------
  function updateStatus() {
    $("gen").textContent = generation;
    $("pop").textContent = population();
    const st = $("status");
    if (holding) { st.dataset.kind = "hold"; st.textContent = "Holding"; st.title = "Evolution waits one bar after an edit"; }
    else { st.dataset.kind = stateInfo.kind; st.textContent = stateInfo.text; st.title = ""; }
    histField.refresh();
    $("histTotal").textContent = `of ${history.length}`;
    $("histVal").textContent = `${cursor + 1} of ${history.length}`;
    $("back").disabled = $("dBack").disabled = cursor <= 0;
    $("hand").disabled = !handState || sameGrid(handState.grid);
    drawSpark();
  }
  function updatePlayButton() {
    ["play", "dPlay"].forEach(id => $(id).setAttribute("aria-pressed", String(playing)));
    document.querySelectorAll(".playLabel").forEach(el => { el.textContent = playing ? "Pause" : "Play"; });
    document.querySelectorAll(".playIcon").forEach(el => el.setAttribute("d", playing ? "M6 4.5h2.5v11H6zM11.5 4.5H14v11h-2.5z" : "M6 4l10 6-10 6z"));
  }
  function syncControls() {
    tempoField.refresh(); volumeField.refresh();
    $("reseed").checked = settings.reseed; $("bass").checked = settings.bass;
    $("scale").value = settings.scale; $("voice").value = settings.voice;
    $("soundVal").textContent = `${$("scale").selectedOptions[0]?.text || ""}, ${($("voice").selectedOptions[0]?.text || "").toLowerCase()}`;
    $("gridVal").textContent = `${COLS} steps`;
    document.querySelectorAll("#evolve button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.v === settings.evolveEvery)));
    document.querySelectorAll("#steps button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.v === COLS)));
  }
  const coarse = matchMedia("(hover: none) and (pointer: coarse)");
  function updateHints() {
    $("hintKeys").hidden = coarse.matches;
    $("hintTouch").hidden = !coarse.matches;
  }
  coarse.addEventListener?.("change", updateHints);

  // Numbers set by dragging sideways, typing, or arrow keys.
  function dragField(input, { min, max, get, set, pxPerStep = 4 }) {
    const box = input.closest(".dragnum");
    const clamp = v => Math.max(min(), Math.min(max(), Math.round(v)));
    const refresh = () => {
      if (document.activeElement !== input) input.value = get();
      input.setAttribute("aria-valuenow", get());
      input.setAttribute("aria-valuemin", min());
      input.setAttribute("aria-valuemax", max());
    };
    const commitTyped = () => { const v = parseInt(input.value, 10); if (!isNaN(v)) set(clamp(v)); refresh(); };
    box.addEventListener("pointerdown", e => {
      if (document.activeElement === input || e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, v0 = get();
      let moved = false;
      try { box.setPointerCapture(e.pointerId); } catch (err) {}
      const move = ev => {
        const d = (ev.clientX - x0) - (ev.pointerType === "mouse" ? ev.clientY - y0 : 0);
        if (!moved && Math.abs(d) < 4) return;
        moved = true; box.classList.add("dragging");
        set(clamp(v0 + d / pxPerStep)); refresh();
      };
      const up = ev => {
        box.removeEventListener("pointermove", move); box.removeEventListener("pointerup", up); box.removeEventListener("pointercancel", up);
        box.classList.remove("dragging");
        if (!moved && ev.type === "pointerup") { input.focus(); input.select(); }
      };
      box.addEventListener("pointermove", move); box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
    });
    input.addEventListener("keydown", e => {
      const delta = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (delta) { e.preventDefault(); set(clamp(get() + delta * (e.shiftKey ? 10 : 1))); input.value = get(); refresh(); }
      else if (e.key === "Enter") { commitTyped(); input.blur(); }
      else if (e.key === "Escape") { input.value = get(); input.blur(); }
    });
    input.addEventListener("blur", commitTyped);
    return { refresh };
  }
  const tempoField = dragField($("tempo"), {
    min: () => 50, max: () => 180, get: () => settings.bpm,
    set: v => { settings.bpm = v; applyAudioSettings(); save(); },
  });
  const volumeField = dragField($("volume"), {
    min: () => 0, max: () => 100, get: () => settings.volume, pxPerStep: 2,
    set: v => { settings.volume = v; applyAudioSettings(); save(); },
  });
  const histField = dragField($("scrub"), {
    min: () => 1, max: () => Math.max(1, history.length), get: () => cursor + 1, pxPerStep: 6,
    set: v => goTo(v - 1),
  });

  // ---------- Bottom sheet on narrow screens ----------
  const narrow = matchMedia("(max-width: 860px)");
  function openSheet() {
    const c = $("console");
    c.classList.add("open");
    c.setAttribute("role", "dialog"); c.setAttribute("aria-modal", "true");
    $("scrim").hidden = false;
    $("dMore").setAttribute("aria-expanded", "true");
    setTimeout(() => $("sheetDone").focus(), 60);
  }
  function closeSheet() {
    const c = $("console");
    if (!c.classList.contains("open")) return;
    const hadFocus = c.contains(document.activeElement);
    c.classList.remove("open");
    c.removeAttribute("role"); c.removeAttribute("aria-modal");
    $("scrim").hidden = true;
    $("dMore").setAttribute("aria-expanded", "false");
    if (hadFocus) $("dMore").focus();
  }
  narrow.addEventListener?.("change", closeSheet);

  // ---------- Help ----------
  let helpReturn = null;
  function openHelp() {
    helpReturn = document.activeElement;
    $("help").hidden = false;
    $("helpClose").focus();
  }
  function closeHelp() {
    if ($("help").hidden) return;
    $("help").hidden = true;
    helpReturn?.focus?.();
  }

  // ---------- First visit ----------
  function showMoods() { $("moods").hidden = false; setTimeout(() => document.querySelector(".mood")?.focus(), 50); }
  function chooseMood(id) {
    $("moods").hidden = true;
    if (id && MOODS[id]) {
      Object.assign(settings, MOODS[id]);
      syncControls(); buildBg(); save();
      requestRender();
      togglePlay();
    }
  }
  function maybeCoach() {
    if (store.get(KEYS.coached)) return;
    clearTimeout(coachTimer);
    coachTimer = setTimeout(() => {
      if (!playing) return;
      store.set(KEYS.coached, true);
      $("coach").hidden = false;
      coachTimer = setTimeout(() => { $("coach").hidden = true; }, 12000);
    }, 2500);
  }

  // ---------- Sections remember open state ----------
  function restoreSections() {
    const saved = store.get(KEYS.sections) || {};
    document.querySelectorAll("details[data-sec]").forEach(d => {
      if (typeof saved[d.dataset.sec] === "boolean") d.open = saved[d.dataset.sec];
      d.addEventListener("toggle", () => {
        const s = store.get(KEYS.sections) || {};
        s[d.dataset.sec] = d.open;
        store.set(KEYS.sections, s);
      });
    });
  }

  // ---------- Wiring ----------
  $("play").addEventListener("click", togglePlay);
  $("dPlay").addEventListener("click", togglePlay);
  $("reseed").addEventListener("change", e => { settings.reseed = e.target.checked; save(); });
  $("bass").addEventListener("change", e => { settings.bass = e.target.checked; save(); });
  $("scale").addEventListener("change", e => { settings.scale = e.target.value; syncControls(); buildBg(); requestRender(); save(); });
  $("voice").addEventListener("change", e => { settings.voice = e.target.value; syncControls(); save(); });
  document.querySelectorAll("#evolve button").forEach(b => b.addEventListener("click", () => { settings.evolveEvery = +b.dataset.v; syncControls(); save(); }));
  document.querySelectorAll("#steps button").forEach(b => b.addEventListener("click", () => changeLength(+b.dataset.v)));
  $("back").addEventListener("click", back);
  $("dBack").addEventListener("click", back);
  $("fwd").addEventListener("click", () => forward(true));
  $("dFwd").addEventListener("click", () => forward(true));
  $("dMore").addEventListener("click", openSheet);
  $("sheetDone").addEventListener("click", closeSheet);
  $("scrim").addEventListener("click", closeSheet);
  $("hand").addEventListener("click", restoreHand);
  $("share").addEventListener("click", copyLink);
  document.querySelectorAll("[data-seed]").forEach(b => b.addEventListener("click", () => { seed(b.dataset.seed); closeSheet(); }));
  document.querySelectorAll("[data-stamp]").forEach(b => b.addEventListener("click", () => setStamp(b.dataset.stamp)));
  $("stampRot").addEventListener("click", () => rotateStamp(1));
  $("stampDone").addEventListener("click", () => setStamp(null));
  document.querySelectorAll("[data-help]").forEach(b => b.addEventListener("click", openHelp));
  $("helpClose").addEventListener("click", closeHelp);
  $("help").addEventListener("click", e => { if (e.target === $("help")) closeHelp(); });
  document.querySelectorAll("[data-mood]").forEach(b => b.addEventListener("click", () => chooseMood(b.dataset.mood)));
  $("moodSkip").addEventListener("click", () => chooseMood(null));
  $("coachOk").addEventListener("click", () => { clearTimeout(coachTimer); $("coach").hidden = true; });
  // Clicking a control shouldn't steal focus from the grid's keyboard shortcuts.
  document.querySelectorAll(".console button, .dock button, .stampchip button").forEach(b => b.addEventListener("mousedown", e => e.preventDefault()));

  // ---------- Keyboard ----------
  const cur = { c: 0, r: 5 };
  let showCursor = false, kbdUsed = false;
  canvas.addEventListener("focus", () => { showCursor = kbdUsed; requestRender(); if (kbdUsed) describeCursor(); });
  canvas.addEventListener("blur", () => { showCursor = false; requestRender(); });
  document.addEventListener("pointerdown", () => { kbdUsed = false; showCursor = false; requestRender(); }, true);
  function describeCursor() {
    const i = idx(cur.c, cur.r);
    const notes = [];
    for (let r = ROWS - 1; r >= 0; r--) if (grid[idx(cur.c, r)]) notes.push(noteName(midiForRow(r)));
    announce(`${noteName(midiForRow(cur.r))}, step ${cur.c + 1}, ${grid[i] ? "on" : "off"}. Step ${cur.c + 1} plays ${notes.length ? notes.join(", ") : "nothing"}.`);
  }
  function moveCursor(dc, dr) { cur.c = wrapC(cur.c + dc); cur.r = wrapR(cur.r + dr); showCursor = true; requestRender(); describeCursor(); }

  function trapTab(container, e) {
    const items = [...container.querySelectorAll("button, input, select, summary, [tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.disabled && !el.hidden && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (!container.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", e => {
    if (e.key === "Tab") {
      kbdUsed = true;
      if (!$("help").hidden) return trapTab($("help"), e);
      if ($("console").classList.contains("open")) return trapTab($("console"), e);
      if (!$("moods").hidden) return trapTab($("moods"), e);
    }
    if (e.key === "Escape") {
      if (!$("help").hidden) { closeHelp(); return; }
      if ($("console").classList.contains("open")) { closeSheet(); return; }
      if (stamp) { setStamp(null); return; }
    }
    if (!$("help").hidden || !$("moods").hidden) return;
    if (e.target.matches?.("input, select, textarea")) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === "z") { e.preventDefault(); e.shiftKey ? forward(false) : back(); return; }
    if ((e.metaKey || e.ctrlKey) && k === "y") { e.preventDefault(); forward(false); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target === canvas) {
      kbdUsed = true;
      const moves = vertical
        ? { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, 1], ArrowRight: [0, -1] }
        : { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      if (moves[e.key]) { e.preventDefault(); moveCursor(...moves[e.key]); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const i = idx(cur.c, cur.r);
        if (stamp) placeStamp(i);
        else { setCell(i, grid[i] ? 0 : 1, true); commit("paint"); }
        describeCursor();
        return;
      }
    }
    if (e.code === "Space") { if (e.target.tagName === "BUTTON" || e.target.tagName === "SUMMARY") return; e.preventDefault(); togglePlay(); }
    else if (e.key === "Home") { e.preventDefault(); rewindPlayhead(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); forward(true); }
    else if (k === "?" || (k === "/" && e.shiftKey)) openHelp();
    else if (stamp && k === "e") rotateStamp(1);
    else if (stamp && k === "q") rotateStamp(-1);
    else if (k === "n") { evolve(); announce(`Generation ${generation}, ${population()} lit, ${stateInfo.text}`); }
    else if (k === "r") seed("random");
    else if (k === "c") seed("clear");
  });

  // ---------- Painting ----------
  let painting = false, paintValue = 1, lastCell = -1, strokeChanged = false;
  function setCell(i, v, audition) {
    if (grid[i] === v) return false;
    grid[i] = v;
    age[i] = 0;
    if (v) {
      born[i] = performance.now(); ghost[i] = 0;
      if (audition && wakeAudio()) {
        playNote(mtof(midiForRow(Math.floor(i / COLS))), actx.currentTime + 0.005, panFor(i % COLS), 0.14, 1, 1);
        strike[i] = performance.now();
      }
    } else ghost[i] = 1;
    markEdit();
    computeDoomed();
    $("pop").textContent = population();
    requestRender();
    return true;
  }
  const pointCell = e => { const rect = canvas.getBoundingClientRect(); return cellAtXY(e.clientX - rect.left, e.clientY - rect.top); };
  function startStroke(i) {
    painting = true; lastCell = i;
    paintValue = grid[i] ? 0 : 1;
    strokeChanged = setCell(i, paintValue, true);
  }
  function endPaint() { if (painting && strokeChanged) commit("paint"); painting = false; lastCell = -1; strokeChanged = false; }

  // Touch: tap toggles, swipe scrolls, press-and-hold starts painting.
  const HOLD_MS = 170, SLOP = 9;
  let touch = null;
  function cancelTouch() { if (touch) clearTimeout(touch.timer); touch = null; }
  canvas.addEventListener("pointerdown", e => {
    const i = pointCell(e); if (i < 0) return;
    if (e.pointerType === "touch") {
      cancelTouch();
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY, i, moved: false, holding: false };
      if (!stamp) touch.timer = setTimeout(() => {
        if (!touch) return;
        touch.holding = true;
        try { navigator.vibrate?.(12); } catch (err) {}
        startStroke(touch.i);
      }, HOLD_MS);
      return;
    }
    if (e.button !== 0) return;
    if (stamp) { placeStamp(i); return; }
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    startStroke(i);
  });
  canvas.addEventListener("pointermove", e => {
    if (touch && e.pointerId === touch.id) {
      if (!touch.holding) {
        if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > SLOP) { touch.moved = true; clearTimeout(touch.timer); }
        return;
      }
    } else if (!painting && stamp && e.pointerType !== "touch") {
      const i = pointCell(e);
      if (i !== hoverCell) { hoverCell = i; requestRender(); }
      return;
    }
    if (!painting) return;
    const i = pointCell(e);
    if (i < 0 || i === lastCell) return;
    lastCell = i;
    strokeChanged = setCell(i, paintValue, true) || strokeChanged;
  });
  canvas.addEventListener("pointerup", e => {
    if (touch && e.pointerId === touch.id) {
      const t = touch; cancelTouch();
      if (t.holding) { endPaint(); return; }
      if (!t.moved) {
        if (stamp) placeStamp(t.i);
        else { startStroke(t.i); endPaint(); }
      }
      return;
    }
    endPaint();
  });
  canvas.addEventListener("pointercancel", () => { cancelTouch(); endPaint(); });
  canvas.addEventListener("pointerleave", () => { if (hoverCell >= 0) { hoverCell = -1; requestRender(); } });
  canvas.addEventListener("touchmove", e => { if (touch && touch.holding) e.preventDefault(); }, { passive: false });
  canvas.addEventListener("contextmenu", e => { if (touch) e.preventDefault(); });

  // ---------- Link and tapes ----------
  function copyLink() {
    const link = SHARE_BASE + "#" + encodeState();
    const out = $("shareOut");
    out.value = link; out.hidden = false;
    const fallback = () => { out.focus(); out.select(); toast("Copy the link above"); };
    try { navigator.clipboard.writeText(link).then(() => toast("Link copied"), fallback); } catch (e) { fallback(); }
  }
  const TAPE_NAMES = ["A", "B", "C", "D"];
  function tapeTime(at) {
    const d = new Date(at), now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  let tapes = [null, null, null, null], confirmTape = -1;
  function loadTapes() { const s = store.get(KEYS.tapes); if (Array.isArray(s)) tapes = [0, 1, 2, 3].map(i => s[i] || null); }
  const saveTapes = () => store.set(KEYS.tapes, tapes);
  function writeTape(n) {
    tapes[n] = { code: encodeState(), at: Date.now(), pop: population() };
    confirmTape = -1;
    saveTapes(); renderTapes(); toast(`Saved to tape ${TAPE_NAMES[n]}`);
  }
  function renderTapes(focusAct) {
    const wrap = $("tapes");
    wrap.innerHTML = "";
    tapes.forEach((t, n) => {
      const el = document.createElement("div");
      const asking = confirmTape === n;
      const name = TAPE_NAMES[n];
      el.className = "tape" + (asking ? " confirm" : "");
      const when = t ? tapeTime(t.at) : "";
      const lit = t ? Number(t.pop) || 0 : 0;
      const detail = asking ? "Record over?" : t ? lit + " lit, " + when : "Blank";
      const label = `<b>${name}</b><small>${detail}</small>`;
      const keys = asking
        ? `<button type="button" data-act="replace">Record</button><button type="button" data-act="cancel">Keep</button>`
        : `<button type="button" data-act="save" aria-label="Save to tape ${name}">Save</button><button type="button" data-act="load" aria-label="Load tape ${name}" ${t ? "" : "disabled"}>Load</button>`;
      const dec = t && decodeState(t.code);
      el.innerHTML = `<div class="tape-label">${label}</div><div class="tape-window">${dec ? "<canvas aria-hidden=\"true\"></canvas>" : "<span class=\"empty\">empty</span>"}</div><div class="tape-keys">${keys}</div>`;
      if (dec) {
        const cv = el.querySelector("canvas");
        const u = 5;
        cv.width = dec.cols * u; cv.height = ROWS * u;
        cv.style.width = (dec.cols * u / 2) + "px"; cv.style.height = (ROWS * u / 2) + "px";
        const m = cv.getContext("2d");
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < dec.cols; c++) if (dec.grid[r * dec.cols + c]) {
          m.fillStyle = `hsl(${hueFor(r)} 100% 65%)`;
          m.fillRect(c * u + 0.5, r * u + 0.5, u - 1, u - 1);
        }
      }
      const on = (act, fn) => { const b = el.querySelector(`[data-act="${act}"]`); if (b) b.addEventListener("click", fn); };
      on("save", () => { if (tapes[n]) { confirmTape = n; renderTapes("replace"); } else writeTape(n); });
      on("replace", () => writeTape(n));
      on("cancel", () => { confirmTape = -1; renderTapes(); });
      on("load", () => {
        const d = tapes[n] && decodeState(tapes[n].code);
        if (!d) return;
        const before = history[cursor];
        applyDecoded(d, "load");
        toast(`Tape ${name} loaded`, before);
        closeSheet();
      });
      el.querySelectorAll("button").forEach(b => b.addEventListener("mousedown", e => e.preventDefault()));
      wrap.appendChild(el);
      if (asking && focusAct) el.querySelector(`[data-act="${focusAct}"]`)?.focus();
    });
  }

  // ---------- Notices ----------
  function notice(text) {
    $("noticeText").textContent = text;
    $("notice").hidden = false;
  }
  $("noticeClose").addEventListener("click", () => { $("notice").hidden = true; });
  function storageWorks() {
    try { localStorage.setItem("orvy-probe", "1"); localStorage.removeItem("orvy-probe"); return true; } catch (e) { return false; }
  }

  // @site-only: recording and offline support. build.py removes this block from the single-file build, whose host blocks downloads and service workers.
  // ---------- Recording ----------
  let recorder = null, recordChunks = [], recordStart = 0, recordTicker = 0;
  const RECORD_LIMIT_MS = 10 * 60 * 1000;
  function recordingType() {
    if (!window.MediaRecorder) return null;
    return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find(t => MediaRecorder.isTypeSupported?.(t)) || "";
  }
  function setupRecording() {
    if (TARGET !== "site" || recordingType() === null || !AudioCtor) return;
    $("record").hidden = false;
    $("record").setAttribute("aria-pressed", "false");
    $("record").addEventListener("click", () => recorder ? stopRecording() : startRecording());
  }
  async function startRecording() {
    if (!initAudio()) return;
    if (!playing) await togglePlay();
    const dest = actx.createMediaStreamDestination();
    comp.connect(dest);
    const type = recordingType();
    try { recorder = new MediaRecorder(dest.stream, type ? { mimeType: type } : undefined); }
    catch (e) { comp.disconnect(dest); toast("Recording isn't available in this browser"); return; }
    recordChunks = [];
    recorder.ondataavailable = e => { if (e.data.size) recordChunks.push(e.data); };
    recorder.onstop = () => {
      comp.disconnect(dest);
      const blob = new Blob(recordChunks, { type: recorder.mimeType || type || "audio/webm" });
      const ext = /mp4/.test(blob.type) ? "m4a" : /ogg/.test(blob.type) ? "ogg" : "webm";
      const d = new Date(), two = n => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `orvy-${stamp}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      recorder = null;
      clearInterval(recordTicker);
      $("record").setAttribute("aria-pressed", "false");
      $("recordLabel").textContent = "Record audio";
      toast("Recording saved");
    };
    recorder.start(1000);
    recordStart = Date.now();
    $("record").setAttribute("aria-pressed", "true");
    const tick = () => {
      const t = Math.floor((Date.now() - recordStart) / 1000);
      $("recordLabel").textContent = `Stop recording ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
      if (Date.now() - recordStart >= RECORD_LIMIT_MS) stopRecording();
    };
    tick();
    recordTicker = setInterval(tick, 500);
  }
  function stopRecording() { if (recorder && recorder.state !== "inactive") recorder.stop(); }

  function registerOffline() {
    if (TARGET !== "site" || !("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  // @end-site-only

  // ---------- Persistence ----------
  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = 0;
    store.set(KEYS.state, {
      grid: Array.from(grid).join(""), cols: COLS, settings, generation,
      hand: handState ? { grid: Array.from(handState.grid).join(""), cols: handState.cols } : null,
    });
  }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
  window.addEventListener("pagehide", () => { if (saveTimer) saveNow(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) saveNow(); });
  const sanitizeSettings = () => OrvyCore.sanitize(settings);
  function load(data) {
    if (!data) return false;
    if (data.settings && typeof data.settings === "object") Object.assign(settings, data.settings);
    sanitizeSettings();
    const cols = STEP_OPTIONS.includes(data.cols) ? data.cols : 16;
    if (typeof data.grid === "string" && data.grid.length === cols * ROWS) {
      COLS = cols; settings.cols = cols; allocate();
      grid = Uint8Array.from(data.grid, ch => ch === "1" ? 1 : 0);
      age = new Uint16Array(N);
      generation = data.generation || 0;
      return true;
    }
    settings.cols = COLS;
    return false;
  }

  window.addEventListener("hashchange", () => {
    const d = linkedPattern();
    if (!d) return;
    const before = history[cursor];
    applyDecoded(d, "load");
    toast("Linked pattern loaded", before);
  });

  function start() {
    if (!AudioCtor) notice("This browser can't play sound. You can still draw and step through generations.");
    else if (!storageWorks()) notice("Saving is off in this browser mode, so your work won't be kept after you close the page.");
    if (TARGET === "site") { setupRecording(); registerOffline(); }
    const stored = store.get(KEYS.state);
    const restored = load(stored);
    syncControls();
    restoreSections();
    loadTapes(); renderTapes();
    drawStampIcons();
    resize();
    updateHints();
    if (!restored || population() === 0) seed("gliders", { silent: true });
    else {
      // Keep the last pattern the person drew as the restore point.
      // Older saves stored the restore point as a bare string at the current length.
      const raw = stored?.hand;
      const hand = typeof raw === "string" ? { grid: raw, cols: COLS } : raw;
      const valid = hand && typeof hand.grid === "string" && STEP_OPTIONS.includes(hand.cols) && hand.grid.length === hand.cols * ROWS;
      if (valid && !(hand.cols === COLS && hand.grid === Array.from(grid).join(""))) {
        const current = grid, currentCols = COLS;
        applyCols(hand.cols);
        grid = Uint8Array.from(hand.grid, ch => ch === "1" ? 1 : 0);
        commit("start");
        applyCols(currentCols);
        grid = current;
        commit("gen");
      } else commit("start");
    }
    const linked = linkedPattern();
    if (linked) {
      const before = history[cursor];
      applyDecoded(linked, "load");
      toast("Linked pattern loaded", before);
    } else if (!stored) showMoods();
    // Resizing the canvas changes the board's size, so defer a frame to avoid a ResizeObserver loop.
    let resizeFrame = 0;
    new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(resize); }).observe($("board"));
    // Canvas labels use the web font; redraw them once it has loaded.
    document.fonts?.ready.then(() => { buildBg(); requestRender(); });
  }
  start();
})();
