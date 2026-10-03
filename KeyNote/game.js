'use strict';
// ====================== constants ======================
const C = { bg:'#0d1014', panel:'#151a21', edge:'#252d38', key:'#1b2129', keyEdge:'#2f3946', text:'#d9dee7', dim:'#6f7b8b',
            blue:'#4a90e2', green:'#4cc38a', orange:'#f0883e', yellow:'#f2d04a', red:'#d95c5c' };
const SERIF = 'Georgia, "Palatino Linotype", "Times New Roman", serif';
const ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'], OFFSETS = [0, .5, .75, 1.25];
const KEYS = ROWS.join('').split('');

// scoring
const TAP_YELLOW = 100, TAP_GREEN = 300, HOLD_PTS = 250, WRONG = 50, HOLD_PEN = 100;
const GREEN_HALF = .25, HOLD_GRACE = .25;   // seconds
const LATENCY = 0;                           // raise if hits feel late

// Notes are placed every BEATS_PER_NOTE beats (4 = BPM / 4 notes per minute). Try 2 for twice as many notes.
const BEATS_PER_NOTE = 2;

const $ = s => document.querySelector(s);
const show = id => document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));

// ====================== song storage (IndexedDB) ======================
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('keynote', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function store(mode, fn) {
  const d = await dbp;
  return new Promise((res, rej) => {
    const t = d.transaction('songs', mode), req = fn(t.objectStore('songs'));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
  });
}

function askBpm(name, initial = 120) {
  let v = prompt(`What's the BPM of "${name}"?`, initial);
  while (v !== null) {
    const n = parseFloat(v);
    if (n >= 30 && n <= 300) return n;
    v = prompt('Enter a number between 30 and 300', initial);
  }
  return null;
}

async function renderList() {
  const songs = (await store('readonly', s => s.getAll())).sort((a, b) => a.title.localeCompare(b.title));
  const ul = $('#list');
  ul.innerHTML = '';
  if (!songs.length) { ul.innerHTML = '<li class="empty">No songs yet. Press + to add one.</li>'; return; }
  for (const s of songs) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><em></em>';
    li.firstChild.textContent = s.title;
    li.lastChild.textContent = s.bpm + ' BPM';
    li.onclick = () => play(s);
    li.oncontextmenu = async e => {
      e.preventDefault();
      const v = prompt(`New BPM for "${s.title}"\n(type REROLL for a fresh beatmap, or DELETE to remove this song)`, s.bpm);
      if (v === null) return;
      const cmd = v.trim().toUpperCase();
      if (cmd === 'DELETE') await store('readwrite', st => st.delete(s.id));
      else if (cmd === 'REROLL') { s.seed = Math.floor(Math.random() * 1e9); s.map = null; await store('readwrite', st => st.put(s)); }
      else { const n = parseFloat(v); if (n >= 30 && n <= 300) { s.bpm = n; s.map = null; await store('readwrite', st => st.put(s)); } }
      renderList();
    };
    ul.append(li);
  }
}

$('#add').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  for (const f of e.target.files) {
    const title = f.name.replace(/\.[^.]+$/, ''), bpm = askBpm(title);
    if (bpm !== null) await store('readwrite', s => s.add({ title, bpm, blob: f }));
  }
  e.target.value = '';
  renderList();
};

// ====================== beatmap ======================
const nWs = n => n.t - n.lead;
const nWe = n => n.hold ? n.t + n.d + 1 : n.t + GREEN_HALF;
const nMax = n => n.hold ? HOLD_PTS : TAP_GREEN;
function zone(n, t) {   // 0 none, 1 yellow, 2 green
  if (n.state !== 'pending' && n.state !== 'held') return 0;
  if (t < nWs(n) || t > nWe(n)) return 0;
  if (!n.hold) return t >= n.t - GREEN_HALF ? 2 : 1;
  return t >= n.t && t <= n.t + n.d ? 2 : 1;
}

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// One note every 4th beat (BPM / 4 notes per minute); ~25% are 1-2 beat holds.
function generate(song, dur) {
  const beat = 60 / song.bpm, iv = beat * BEATS_PER_NOTE;
  let h = 0; for (const ch of song.title) h = Math.imul(31, h) + ch.charCodeAt(0) | 0;
  const r = rng(h + Math.round(song.bpm * 100) + (song.seed || 0)), notes = [], recent = [];
  for (let k = 1; ; k++) {
    const t = k * iv;
    if (t < 2) continue;                      // room for the 2s yellow lead-in
    if (t + GREEN_HALF > dur) break;
    let hold = r() < .25, d = hold ? beat * (1 + Math.floor(r() * 2)) : 0;
    if (hold && t + d + 1 > dur) { hold = false; d = 0; }
    let key; do { key = KEYS[Math.floor(r() * KEYS.length)]; } while (recent.includes(key));
    recent.push(key); if (recent.length > 3) recent.shift();
    notes.push({ key, hold, t, d, lead: hold ? 1 : 2, state: 'pending', pt: 0 });
  }
  return notes;
}

// Beatmaps are saved on the song record, so a song plays the same map every time.
// A new one is made only if there's none yet, or the BPM / BEATS_PER_NOTE changed since it was saved.
async function getMap(song, dur) {
  const m = song.map;
  if (m && m.div === BEATS_PER_NOTE && m.bpm === song.bpm)
    return m.notes.map(n => ({ ...n, state: 'pending', pt: 0 }));
  const notes = generate(song, dur);
  song.map = { div: BEATS_PER_NOTE, bpm: song.bpm, notes: notes.map(({ key, hold, t, d, lead }) => ({ key, hold, t, d, lead })) };
  try { await store('readwrite', s => s.put(song)); } catch (e) { console.warn('Could not save beatmap', e); }
  return notes;
}

// ====================== game ======================
const cv = $('#cv'), g = cv.getContext('2d');
let G = null;

function play(song) {
  show('game');
  $('#overlay').hidden = true;
  const url = URL.createObjectURL(song.blob), a = new Audio(url);
  G = { song, a, url, phase: 'loading', notes: [], down: {}, flash: {}, score: 0, total: 0, dur: 0, t: 0, jt: '', jc: C.text, jn: 0 };
  const me = G;
  a.onloadedmetadata = async () => {
    if (!isFinite(a.duration) || a.duration <= 0) return fail("Couldn't work out how long this song is.");
    me.dur = a.duration;
    me.notes = await getMap(song, me.dur);
    if (G !== me) return;                      // left the screen while loading
    me.total = me.notes.reduce((s, n) => s + nMax(n), 0);
    a.play().then(() => me.phase = 'playing').catch(err => fail('Playback was blocked: ' + err.message));
  };
  a.onended = finish;
  a.onerror = () => fail("Couldn't play this audio file.");
  requestAnimationFrame(loop);
}

const now = () => G.a.currentTime - LATENCY;
function judge(text, color) { G.jt = text; G.jc = color; G.jn = performance.now(); }
function addScore(d, text, color) { G.score += d; judge(text + (d > 0 ? ' +' : ' ') + d, color); }
function flash(key, color) { G.flash[key] = { color, t0: performance.now() }; }

function finish() {
  if (!G || G.phase !== 'playing') return;
  G.phase = 'finished';
  for (const n of G.notes) if (n.state === 'held') { n.state = 'failed'; G.score -= HOLD_PEN; }
  $('#ohead').textContent = 'Song complete';
  $('#oscore').hidden = false;
  $('#oscore').textContent = `${G.score} / ${G.total}`;
  $('#odetail').textContent = (G.total ? Math.max(0, G.score) * 100 / G.total : 0).toFixed(1) + '% of the possible score';
  $('#overlay').hidden = false;
  $('#back').focus();
}
function fail(msg) {
  if (!G) return;
  G.phase = 'error';
  $('#ohead').textContent = 'Something went wrong';
  $('#oscore').hidden = true;
  $('#odetail').textContent = msg;
  $('#overlay').hidden = false;
}
function exit() {
  if (!G) return;
  G.a.pause(); URL.revokeObjectURL(G.url); G = null;
  show('select'); renderList();
}
$('#back').onclick = exit;

// a key pressed too early before / too late after a hold counts as a hold penalty
function nearHold(key, t) {
  return G.notes.some(n => n.hold && n.key === key && ((t >= nWs(n) - 4 && t < nWs(n)) || (t > nWe(n) && t <= nWe(n) + 2)));
}

function press(key, t) {
  const n = G.notes.find(n => n.key === key && n.state === 'pending' && t >= nWs(n) && t <= nWe(n));
  if (!n) { addScore(-(nearHold(key, t) ? HOLD_PEN : WRONG), 'Miss', C.red); flash(key, C.red); return; }
  if (!n.hold) {
    const green = zone(n, t) === 2;
    n.state = 'done';
    if (green) { addScore(TAP_GREEN, 'Perfect', C.green); flash(key, C.green); }
    else { addScore(TAP_YELLOW, 'Good', C.yellow); flash(key, C.yellow); }
  } else { n.state = 'held'; n.pt = t; judge('Hold...', C.orange); }
}

function release(key, t) {
  for (const n of G.notes) {
    if (n.key !== key || n.state !== 'held') continue;
    if (t > nWe(n)) { n.state = 'failed'; addScore(-HOLD_PEN, 'Held too long', C.red); flash(key, C.red); }
    else if (n.pt <= n.t + HOLD_GRACE && t >= n.t + n.d - HOLD_GRACE) { n.state = 'done'; addScore(HOLD_PTS, 'Held', C.green); flash(key, C.green); }
    else { n.state = 'missed'; judge(n.pt > n.t + HOLD_GRACE ? 'Hold started late' : 'Released early', C.orange); }
  }
}

const keyOf = e => /^Key[A-Z]$/.test(e.code) ? e.code[3] : /^Digit\d$/.test(e.code) ? e.code[5] : null;

addEventListener('keydown', e => {
  if (!G) return;
  if (e.code === 'Escape') return exit();
  if (G.phase === 'playing' || G.phase === 'loading') e.preventDefault();
  const k = keyOf(e);
  if (G.phase !== 'playing' || !k || e.repeat || k in G.down) return;
  const t = now();
  G.down[k] = t;
  press(k, t);
});
addEventListener('keyup', e => {
  const k = keyOf(e);
  if (!G || !k || !(k in G.down)) return;
  delete G.down[k];
  if (G.phase === 'playing') release(k, now());
});

function update() {
  if (G.phase !== 'playing') return;
  const t = G.t = now();
  for (const n of G.notes) {
    if (n.state === 'pending') {
      if (t > nWe(n)) n.state = 'missed';                                   // never attempted: no penalty
      else if (n.hold && t >= nWs(n) && G.down[n.key] !== undefined && G.down[n.key] < nWs(n)) n.state = 'failed'; // held before the yellow
    } else if (n.state === 'held' && t > nWe(n)) {                          // still held after the last yellow
      n.state = 'failed'; addScore(-HOLD_PEN, 'Held too long', C.red); flash(n.key, C.red);
    }
  }
}

// ====================== drawing ======================
function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function knob(cx, cy, r, v, accent) {
  v = Math.max(0, Math.min(1, v));
  g.lineCap = 'round'; g.lineWidth = 2;
  for (let i = 0; i < 11; i++) {
    const f = i / 10, a = (135 + 270 * f) * Math.PI / 180;
    g.strokeStyle = f <= v + 1e-9 ? accent : C.keyEdge;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 1.22, cy + Math.sin(a) * r * 1.22);
    g.lineTo(cx + Math.cos(a) * r * 1.4, cy + Math.sin(a) * r * 1.4); g.stroke();
  }
  g.fillStyle = C.key; g.strokeStyle = C.keyEdge;
  g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.stroke();
  g.strokeStyle = C.edge; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, r * .7, 0, 7); g.stroke();
  const a = (135 + 270 * v) * Math.PI / 180;
  g.strokeStyle = accent; g.lineWidth = Math.max(2, r * .07);
  g.beginPath(); g.moveTo(cx + Math.cos(a) * r * .3, cy + Math.sin(a) * r * .3);
  g.lineTo(cx + Math.cos(a) * r * .88, cy + Math.sin(a) * r * .88); g.stroke();
}
function text(s, x, y, font, color, align = 'left', base = 'top') {
  g.font = font; g.fillStyle = color; g.textAlign = align; g.textBaseline = base; g.fillText(s, x, y);
}
function legend(x, y, color, label) {
  g.fillStyle = color; rr(x, y - 7, 14, 14, 4); g.fill();
  text(label, x + 22, y, `italic 15px ${SERIF}`, C.dim, 'left', 'middle');
  return x + 22 + g.measureText(label).width + 30;   // x for the next item
}

function draw() {
  const dpr = devicePixelRatio || 1, w = innerWidth, h = innerHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
  const t = G.t, ms = performance.now();

  // header
  const title = G.song.title.length > 34 ? G.song.title.slice(0, 33) + '…' : G.song.title;
  text(title, 40, 26, `bold 30px ${SERIF}`, C.text);
  text(G.song.bpm + ' BPM', 40, 66, `italic 16px ${SERIF}`, C.orange);
  text('SCORE', w - 125, 24, `13px ${SERIF}`, C.dim, 'right');
  text(String(G.score), w - 125, 40, `bold 36px ${SERIF}`, C.text, 'right');
  const prog = G.dur ? Math.max(0, Math.min(1, t / G.dur)) : 0;
  knob(w - 62, 56, 22, prog, C.blue);
  g.fillStyle = C.edge; g.fillRect(40, 104, w - 80, 2);
  g.fillStyle = C.blue; g.fillRect(40, 104, (w - 80) * prog, 2);

  // judgement text
  const age = (ms - G.jn) / 900;
  if (age < 1 && G.jt) { g.globalAlpha = 1 - age; text(G.jt, w / 2, 124, `bold 28px ${SERIF}`, G.jc, 'center'); g.globalAlpha = 1; }

  // which keys are lit
  const zones = {}, lit = {};
  if (G.phase === 'playing') for (const n of G.notes) { const z = zone(n, t); if (z > (zones[n.key] || 0)) { zones[n.key] = z; lit[n.key] = n; } }

  // keyboard
  const unit = Math.min(80, (w - 100) / 10.5), gap = unit * .12, ks = unit - gap;
  const kbW = 10.5 * unit - gap, kbH = 4 * unit - gap, x0 = (w - kbW) / 2, y0 = Math.max(185, (h - kbH) / 2 + 30);
  g.fillStyle = C.panel; rr(x0 - 26, y0 - 26, kbW + 52, kbH + 52, 20); g.fill();
  g.strokeStyle = C.edge; g.lineWidth = 1.5; g.stroke();

  ROWS.forEach((row, r) => [...row].forEach((ch, c) => {
    const x = x0 + (OFFSETS[r] + c) * unit, y = y0 + r * unit, z = zones[ch] || 0, n = lit[ch];
    let fill = C.key, edge = C.keyEdge, tc = C.dim;
    if (z === 2) fill = edge = C.green, tc = C.bg;
    else if (z === 1) fill = edge = n.hold ? C.orange : C.yellow, tc = C.bg;
    else if (ch in G.down) fill = C.keyEdge, tc = C.text;

    if (z === 1 && n && t < n.t) {                    // approach ring closes in during the yellow lead-in
      const ap = Math.max(0, Math.min(1, (n.t - t) / n.lead)), e = ap * ks * .45;
      g.globalAlpha = .35 + .5 * (1 - ap); g.strokeStyle = n.hold ? C.orange : C.yellow; g.lineWidth = 2;
      rr(x - e, y - e, ks + 2 * e, ks + 2 * e, 12 + e); g.stroke(); g.globalAlpha = 1;
    }
    g.fillStyle = fill; rr(x, y, ks, ks, 12); g.fill();
    const f = G.flash[ch];
    if (f && z === 0) {
      const a = 1 - (ms - f.t0) / 350;
      if (a > 0) { g.globalAlpha = a * .85; g.fillStyle = f.color; rr(x, y, ks, ks, 12); g.fill(); g.globalAlpha = 1; }
    }
    g.strokeStyle = edge; g.lineWidth = 1.5; rr(x, y, ks, ks, 12); g.stroke();
    if (z && n.hold) {                                // HOLD tag + bar: shown from the first orange, drains only during the green
      const frac = t < n.t ? 1 : Math.max(0, Math.min(1, (n.t + n.d - t) / n.d));
      g.fillStyle = 'rgba(13,16,20,.3)'; rr(x + 8, y + ks - 14, ks - 16, 6, 3); g.fill();
      g.fillStyle = C.bg; rr(x + 8, y + ks - 14, (ks - 16) * frac, 6, 3); g.fill();
      text('HOLD', x + ks / 2, y + 7, `bold ${ks * .17}px ${SERIF}`, tc, 'center');
    }
    text(ch, x + ks / 2, y + ks / 2 - 1, `bold ${ks * .42}px ${SERIF}`, tc, 'center', 'middle');
  }));

  // legend + hint
  const ly = y0 + kbH + 58;
  const items = [[C.yellow, 'get ready (100)'], [C.orange, 'hold: get ready (250)'], [C.green, 'hit now (300)'], [C.red, 'wrong key / off time']];
  g.font = `italic 15px ${SERIF}`;
  let lx = (w - items.reduce((sum, [, l]) => sum + 22 + g.measureText(l).width + 30, -30)) / 2;
  for (const [c, l] of items) lx = legend(lx, ly, c, l);
  text('Esc to quit', 40, h - 24, `italic 14px ${SERIF}`, C.dim, 'left', 'bottom');
  if (G.phase === 'loading') text('Loading...', w / 2, 150, `italic 24px ${SERIF}`, C.dim, 'center', 'middle');
}

function loop() {
  if (!G) return;
  update(); draw();
  requestAnimationFrame(loop);
}

// ====================== start ======================
setTimeout(() => { show('select'); renderList(); }, 5000);
