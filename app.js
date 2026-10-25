'use strict';

/* =====================================================================
   Утилиты
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TAU = Math.PI * 2;
const POINTER = -Math.PI / 2; // стрелка сверху
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mod = (a, n) => ((a % n) + n) % n;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Честный рандом для выбора победителя
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('gg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('gg.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('gg.' + k); } catch {} },
};

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/* =====================================================================
   Состояние
   ===================================================================== */
const DEFAULTS = {
  channel: '',
  joinCmd: '!join',
  leaveCmd: '!leave',
  allowChoice: true,
  maxChoices: 0,
  excludeBroadcaster: true,
  gameMode: 'elim',        // колесо игр: elim — выбивает по одной, pick — где остановилось, та и разыгрывается
  playerMode: 'pick',      // колесо зрителей: pick — один спин, elim — выбывают по одному
  gameSpinDuration: 8,     // каждый спин колеса игр
  playerElimDuration: 6,   // раунды выбывания зрителей (финал из двух — со «спином победителя»)
  spinDuration: 30,        // спин победителя
  easing: 'smooth',        // smooth | dramatic | tease
  autoContinue: true,
  skipEmptyGames: true,
  subsOnly: false,
  subLuck: 1,
  winnersCanRepeat: true, // победитель остаётся на колесе следующих игр
  confirmEnabled: false,
  confirmSeconds: 60,
  sound: true,
  volume: 0.6,
  confetti: true,
};

const state = {
  settings: { ...DEFAULTS, ...store.get('settings', {}) },
  games: [],
  participants: store.get('participants', {}), // login -> {login, name, color, sub, mod, vip, games: 'all' | [id], joinedAt}
  results: store.get('results', {}),           // gameId -> [{login, name, color, at}]
  regOpen: store.get('regOpen', true),
  // Этап 1 «games»: колесо выбирает игру. Этап 2 «players»: колесо выбирает, кто её получит.
  // eliminated — выбывшие игры, out — выбывшие зрители, rerolled — перекрученные победители.
  round: { phase: 'games', gameId: null, eliminated: [], out: [], rerolled: [] },
  spinning: false,
  transitioning: false,
  paused: false,
  lastWonId: null, // последняя разыгранная игра — держим её первой в списке до следующего выбора
  pending: null, // победитель в модалке
};

const S = () => state.settings;
const saveParticipants = () => store.set('participants', state.participants);
const saveResults = () => store.set('results', state.results);

/* =====================================================================
   Игры
   ===================================================================== */
function normGame(g, i) {
  const title = String(g.title || g.name || `Игра ${i + 1}`).trim();
  const appid = String(g.steamAppId || g.steam || '').trim();
  return {
    id: String(g.id || title.toLowerCase()),
    title,
    steamAppId: appid,
    image: String(g.image || '').trim(),
    short: String(g.short || '').trim(), // короткая подпись на колесе
    platform: String(g.platform || (appid ? 'Steam' : '')).trim(),
    count: Math.max(1, parseInt(g.count, 10) || 1),
  };
}

function gameImage(g) {
  if (g.image) return g.image;
  if (g.steamAppId) return `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(g.steamAppId)}/header.jpg`;
  return '';
}

function setGames(list) {
  const seen = new Set();
  state.games = (list || []).map(normGame).filter(g => {
    if (!g.title || seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });
}

async function loadGames() {
  const local = store.get('games', null);
  if (local) { setGames(local); return; }
  try {
    const r = await fetch('games.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    setGames(Array.isArray(data) ? data : data.games);
  } catch (e) {
    setGames([]);
    toast('Не удалось загрузить games.json', 'warn');
  }
}

const phase = () => (state.games.length ? state.round.phase : 'players');
const selectedGame = () => (phase() === 'players' && state.games.find(g => g.id === state.round.gameId)) || null;
const gameResults = g => (g && state.results[g.id]) || [];
const gameDone = g => !!g && gameResults(g).length >= g.count;
const gameNumber = g => state.games.indexOf(g) + 1;

function winnersSet() {
  const s = new Set();
  Object.values(state.results).forEach(list => list.forEach(w => s.add(w.login)));
  return s;
}

function wantsGame(p, g) {
  return !g || p.games === 'all' || p.games.includes(g.id);
}

/* =====================================================================
   Кто сейчас на колесе
   ===================================================================== */
function eligible(g = selectedGame()) {
  const winners = S().winnersCanRepeat ? new Set() : winnersSet();
  return Object.values(state.participants)
    .filter(p => !(S().subsOnly && !p.sub))
    .filter(p => wantsGame(p, g))
    .filter(p => !winners.has(p.login))
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

// Игры, которые ещё крутятся на колесе игр
function gamePool() {
  const out = new Set(state.round.eliminated);
  return state.games.filter(g => !gameDone(g) && !out.has(g.id) && (!S().skipEmptyGames || eligible(g).length));
}

function playerPool() {
  const out = new Set([...state.round.out, ...state.round.rerolled]);
  return eligible().filter(p => !out.has(p.login));
}

// Режим колеса текущего этапа: 'elim' или 'pick'
const modeOf = ph => (ph === 'games' ? S().gameMode : S().playerMode);

function wheelEntries() {
  if (phase() === 'games') return gamePool().map(g => ({ key: g.id, label: g.short || g.title, sub: false, ref: g }));
  return playerPool().map(p => ({ key: p.login, label: p.name, color: p.color, sub: p.sub, ref: p }));
}

function resetRound() {
  state.round = { phase: 'games', gameId: null, eliminated: [], out: [], rerolled: [] };
  state.paused = false;
}

const weightOf = p => (p.sub ? Math.max(1, +S().subLuck || 1) : 1);

/* =====================================================================
   Звук (WebAudio, без файлов)
   ===================================================================== */
const Sound = {
  ctx: null,
  out: null,   // общий выход: мягкий срез верхов + компрессор, чтобы ничего не било по ушам
  echo: null,  // посыл в лёгкое эхо (задержка с затуханием)
  noise: null, // буфер шума для щелчков и «вжуха»
  lastTick: 0,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { this.ctx = new AC(); this.build(); }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  build() {
    const c = this.ctx;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.knee.value = 14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6500;
    this.out = c.createGain();
    this.out.connect(lp).connect(comp).connect(c.destination);

    this.echo = c.createGain();
    const delay = c.createDelay(1);
    delay.delayTime.value = 0.17;
    const damp = c.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2600;
    const fb = c.createGain();
    fb.gain.value = 0.33;
    this.echo.connect(delay).connect(damp).connect(fb).connect(delay);
    damp.connect(this.out);

    const len = c.sampleRate;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const ch = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  },
  env(g, t, vol, attack, dur) {
    const v = Math.max(0.0002, vol * S().volume);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  },
  tone(freq, dur, { type = 'sine', vol = 0.2, when = 0, slideTo = 0, attack = 0.01, wet = 0 } = {}) {
    const c = this.ctx;
    if (!c || !S().sound) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    this.env(g, t, vol, attack, dur);
    o.connect(g).connect(this.out);
    if (wet) { const s = c.createGain(); s.gain.value = wet; g.connect(s).connect(this.echo); }
    o.start(t);
    o.stop(t + dur + 0.05);
  },
  // Колокольчик: чистый тон и тихие «стеклянные» обертоны
  bell(freq, dur, vol, when = 0) {
    this.tone(freq, dur, { vol, when, attack: 0.004, wet: 0.5 });
    this.tone(freq * 2.76, dur * 0.4, { vol: vol * 0.16, when, attack: 0.003, wet: 0.4 });
    this.tone(freq * 5.4, dur * 0.15, { vol: vol * 0.05, when, attack: 0.002 });
  },
  hiss(dur, { freq = 2000, sweepTo = 0, q = 1, vol = 0.1, type = 'bandpass', attack = 0.003, when = 0 } = {}) {
    const c = this.ctx;
    if (!c || !S().sound) return;
    const t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = c.createGain();
    this.env(g, t, vol, attack, dur);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  },
  // Деревянный щелчок колышка, с лёгким разбросом высоты, чтобы не звучал как метроном
  tick() {
    const c = this.ctx;
    if (!c || c.currentTime - this.lastTick < 0.04) return;
    this.lastTick = c.currentTime;
    const p = 0.9 + Math.random() * 0.2;
    this.hiss(0.035, { freq: 1700 * p, q: 3, vol: 0.5, attack: 0.002 });
    this.tone(820 * p, 0.045, { vol: 0.07, attack: 0.002 });
  },
  // Мягкий «вжух» при старте спина
  start() { this.hiss(0.75, { freq: 280, sweepTo: 1600, q: 0.9, vol: 0.14, attack: 0.28 }); },
  // Выбывание: приглушённое «бу-ум» вниз
  elim() {
    this.tone(330, 0.5, { vol: 0.15, slideTo: 160, wet: 0.25 });
    this.tone(165, 0.4, { type: 'triangle', vol: 0.07, slideTo: 110, when: 0.02 });
    this.hiss(0.14, { freq: 450, q: 0.7, vol: 0.05, type: 'lowpass' });
  },
  // Колесо выбрало игру: восходящий перелив
  reveal() { [659.25, 783.99, 987.77, 1318.51].forEach((f, i) => this.bell(f, 1.2, 0.11, i * 0.09)); },
  // Победа: арпеджио колокольчиков и тёплый аккорд под ним
  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.bell(f, 1.0, 0.13, i * 0.12));
    [523.25, 659.25, 783.99].forEach(f => this.tone(f, 2.3, { type: 'triangle', vol: 0.045, when: 0.5, attack: 0.3, wet: 0.4 }));
    this.bell(1567.98, 1.6, 0.07, 0.56);
  },
  join() { this.bell(1318.51, 0.35, 0.05); },
};

/* =====================================================================
   Конфетти
   ===================================================================== */
const Confetti = {
  cv: null, ctx: null, parts: [], running: false,
  colors: ['#ffcc4d', '#ff4fd8', '#9146ff', '#2de2e6', '#7cff6b', '#ffffff', '#ff5e7a'],
  init() {
    this.cv = $('#confetti');
    this.ctx = this.cv.getContext('2d');
    this.resize();
    addEventListener('resize', () => this.resize());
  },
  resize() {
    const d = devicePixelRatio || 1;
    this.cv.width = innerWidth * d;
    this.cv.height = innerHeight * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  },
  burst(x, y, n, spread, angle, power) {
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const v = power * (0.35 + Math.random() * 0.85);
      this.parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        g: 0.18 + Math.random() * 0.12, w: 6 + Math.random() * 7, h: 9 + Math.random() * 10,
        r: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.35, life: 0,
        max: 180 + Math.random() * 90, c: this.colors[(Math.random() * this.colors.length) | 0],
        round: Math.random() < 0.3,
      });
    }
    if (!this.running) { this.running = true; requestAnimationFrame(() => this.step()); }
  },
  celebrate() {
    if (!S().confetti) return;
    const w = innerWidth, h = innerHeight;
    this.burst(w / 2, h * 0.42, 170, TAU, 0, 15);
    setTimeout(() => { this.burst(0, h, 110, 0.8, -Math.PI / 3, 24); this.burst(w, h, 110, 0.8, -2 * Math.PI / 3, 24); }, 260);
    setTimeout(() => this.burst(w / 2, h * 0.25, 120, TAU, 0, 12), 800);
  },
  small(x, y) { if (S().confetti) this.burst(x, y, 40, TAU, 0, 8); },
  step() {
    const { ctx } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.parts = this.parts.filter(p => p.life < p.max && p.y < innerHeight + 40);
    for (const p of this.parts) {
      p.life++;
      p.vx *= 0.985; p.vy = p.vy * 0.985 + p.g;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (p.max - p.life) / 40);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.scale(1, Math.cos(p.life * 0.18));
      ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, TAU); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (this.parts.length) requestAnimationFrame(() => this.step());
    else { this.running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  },
};

/* =====================================================================
   Колесо
   ===================================================================== */
const PALETTE = [
  ['#9146FF', '#fff'], ['#FF4FD8', '#fff'], ['#2DE2E6', '#140a26'], ['#FFB547', '#140a26'],
  ['#5B8CFF', '#fff'], ['#FF5E7A', '#fff'], ['#7CFF6B', '#140a26'], ['#C77DFF', '#fff'],
];

const W = {
  cv: null, ctx: null, size: 0, dpr: 1, r: 0, cache: null,
  segs: [], empty: true, rot: 0, lastIdx: -1, kick: 0, highlight: null,
};

function buildSegments(entries) {
  if (!entries.length) {
    W.empty = true;
    W.segs = Array.from({ length: 12 }, (_, i) => ({
      e: null, start: i * TAU / 12, size: TAU / 12, prob: 1 / 12,
      color: i % 2 ? '#2a1b4a' : '#1f1339', text: '#6c5a95',
    }));
    return;
  }
  W.empty = false;
  // На колесе игр все равны, на колесе игроков сабам можно дать больше шансов
  // (на выбывание — наоборот, сектор саба меньше: ему реже выпадает вылет)
  const players = phase() === 'players';
  const inv = players && S().playerMode === 'elim';
  const ws = entries.map(e => (players ? (inv ? 1 / weightOf(e.ref) : weightOf(e.ref)) : 1));
  const total = ws.reduce((a, b) => a + b, 0);
  const n = entries.length;
  let a = 0;
  W.segs = entries.map((e, i) => {
    let ci = i % PALETTE.length;
    if (n > 1 && i === n - 1 && ci === 0) ci = 3; // последний не должен совпасть с первым
    const size = ws[i] / total * TAU;
    const s = { e, start: a, size, prob: ws[i] / total, color: PALETTE[ci][0], text: PALETTE[ci][1] };
    a += size;
    return s;
  });
}

function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function drawWheelCache() {
  const { size, dpr } = W;
  if (!size) return;
  const r = W.r = size / 2 - size * 0.058;
  const c = W.cache || (W.cache = document.createElement('canvas'));
  c.width = c.height = Math.ceil(r * 2 * dpr);
  const x = c.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, r * dpr, r * dpr);

  for (const s of W.segs) {
    x.beginPath();
    x.moveTo(0, 0);
    x.arc(0, 0, r, s.start, s.start + s.size);
    x.closePath();
    x.fillStyle = s.color;
    x.fill();
  }
  if (W.segs.length > 1 && W.segs.length < 300) {
    x.strokeStyle = 'rgba(255,255,255,.28)';
    x.lineWidth = Math.max(1, r * 0.005);
    for (const s of W.segs) {
      x.beginPath();
      x.moveTo(0, 0);
      x.lineTo(Math.cos(s.start) * r, Math.sin(s.start) * r);
      x.stroke();
    }
  }
  const g = x.createRadialGradient(0, 0, r * 0.08, 0, 0, r);
  g.addColorStop(0, 'rgba(255,255,255,.22)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(0.92, 'rgba(0,0,0,.18)');
  g.addColorStop(1, 'rgba(0,0,0,.42)');
  x.fillStyle = g;
  x.beginPath();
  x.arc(0, 0, r, 0, TAU);
  x.fill();

  const showStar = S().subLuck > 1 && phase() === 'players';
  for (const s of W.segs) {
    let fs = Math.min(r * 0.085, s.size * r * 0.55 * 0.8);
    if (fs < 7) continue;
    const label = s.e ? (showStar && s.e.sub ? '★ ' : '') + s.e.label : '?';
    const maxW = r * 0.66;
    x.save();
    x.rotate(s.start + s.size / 2);
    x.font = `800 ${fs}px Manrope, sans-serif`;
    // Длинное название сначала ужимаем шрифтом (до 11px), и только потом обрезаем
    const w = x.measureText(label).width;
    if (w > maxW) {
      fs = Math.max(fs * maxW / w, Math.min(fs, 11));
      x.font = `800 ${fs}px Manrope, sans-serif`;
    }
    x.textAlign = 'right';
    x.textBaseline = 'middle';
    x.fillStyle = s.text;
    x.shadowColor = s.text === '#fff' ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.35)';
    x.shadowBlur = 4;
    x.fillText(fitText(x, label, maxW), r * 0.92, 0);
    x.restore();
  }
}

function resizeWheel() {
  const box = $('#wheelWrap').getBoundingClientRect();
  const size = Math.round(box.width);
  if (!size) return;
  W.dpr = Math.min(devicePixelRatio || 1, 2);
  W.size = size;
  W.cv.width = W.cv.height = Math.round(size * W.dpr);
  drawWheelCache();
}

function segAt(a) {
  for (let i = 0; i < W.segs.length; i++) {
    const s = W.segs[i];
    if (a >= s.start && a < s.start + s.size) return i;
  }
  return W.segs.length - 1;
}

function setRot(rot) {
  W.rot = rot;
  const idx = segAt(mod(POINTER - rot, TAU));
  if (idx !== W.lastIdx) {
    W.lastIdx = idx;
    if (state.spinning) {
      W.kick = 1;
      Sound.tick();
      const s = W.segs[idx];
      if (s && s.e) setLiveName(s.e.label, s.e.color || s.color);
    }
  }
}

function drawFrame(now) {
  const { ctx, size, dpr } = W;
  if (!size || !W.cache) return;
  const R = size / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.translate(R, R);

  // обод
  const outer = R - 2, inner = W.r;
  const rg = ctx.createLinearGradient(-R, -R, R, R);
  rg.addColorStop(0, '#4b2a8f');
  rg.addColorStop(0.5, '#1b0f33');
  rg.addColorStop(1, '#5a2f9e');
  ctx.beginPath();
  ctx.arc(0, 0, outer, 0, TAU);
  ctx.fillStyle = rg;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffcc4d';
  ctx.stroke();

  // сектора
  ctx.save();
  ctx.rotate(W.rot);
  ctx.drawImage(W.cache, -inner, -inner, inner * 2, inner * 2);
  const h = W.highlight;
  if (h && W.segs[h.idx]) {
    const s = W.segs[h.idx];
    const pulse = 0.5 + 0.5 * Math.sin((now - h.t0) / 90);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, inner, s.start, s.start + s.size);
    ctx.closePath();
    ctx.fillStyle = h.kind === 'win' ? `rgba(255,236,150,${0.2 + 0.35 * pulse})` : `rgba(15,0,8,${0.3 + 0.4 * pulse})`;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = h.kind === 'win' ? '#ffcc4d' : '#ff4d6d';
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(0, 0, inner, 0, TAU);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,204,77,.85)';
  ctx.stroke();

  // лампочки
  const n = 28, br = (outer + inner) / 2, bs = Math.max(2.5, (outer - inner) * 0.2);
  const phase = state.spinning ? Math.floor(now / 70) : Math.floor(now / 550);
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU;
    const lit = state.spinning ? (i + phase) % 3 === 0 : (i + phase) % 2 === 0;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * br, Math.sin(a) * br, bs, 0, TAU);
    if (lit) { ctx.shadowColor = '#ffcc4d'; ctx.shadowBlur = 14; ctx.fillStyle = '#fff6cf'; }
    else { ctx.shadowBlur = 0; ctx.fillStyle = '#8a6a2a'; }
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function loop(now) {
  drawFrame(now);
  if (W.kick > 0.01) {
    W.kick *= 0.82;
    $('#pointer').style.transform = `translateX(-50%) rotate(${W.kick * 24}deg)`;
  }
  requestAnimationFrame(loop);
}

const EASE = {
  smooth: k => 1 - Math.pow(1 - k, 3),
  dramatic: k => 1 - Math.pow(1 - k, 5),
};
const easeInOut = k => 0.5 - Math.cos(Math.PI * k) / 2;

function animateTo(idx, ms, easing) {
  return new Promise(resolve => {
    const seg = W.segs[idx];
    const target = seg.start + seg.size * (0.12 + 0.76 * rand());
    const from = W.rot;
    const turns = Math.round(2 + ms / 1000);
    const to = from + mod(POINTER - target - from, TAU) + turns * TAU;
    // «Интрига»: проскакиваем в соседний сектор и откатываемся назад
    const over = easing === 'tease' ? Math.min(target - seg.start + 0.06, 0.7) : 0;
    const ease = EASE[easing] || EASE.smooth;
    const t0 = performance.now();
    const frame = now => {
      const k = clamp((now - t0) / ms, 0, 1);
      if (over) {
        const split = 0.84;
        setRot(k < split
          ? from + (to + over - from) * EASE.smooth(k / split)
          : to + over - over * easeInOut((k - split) / (1 - split)));
      } else {
        setRot(from + (to - from) * ease(k));
      }
      if (k < 1 && !finished) requestAnimationFrame(frame);
      else finish();
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setRot(mod(to, TAU));
      resolve();
    };
    requestAnimationFrame(frame);
    // Во фоновой вкладке кадры не идут — доводим спин по таймеру, чтобы розыгрыш не завис
    setTimeout(finish, ms + 500);
  });
}

/* =====================================================================
   Розыгрыш
   ===================================================================== */
async function spin() {
  if (state.spinning || state.pending || state.transitioning) return;
  Sound.ensure();
  const games = phase() === 'games';
  const entries = wheelEntries();
  if (!entries.length) {
    toast(games ? 'Нет игр для розыгрыша' : 'На колесе пока никого нет', 'warn');
    const w = $('#wheelWrap');
    w.classList.remove('shake'); void w.offsetWidth; w.classList.add('shake');
    return;
  }
  // Один остался — крутить нечего
  if (entries.length === 1 && (games || S().playerMode === 'elim')) {
    if (games) chooseGame(entries[0].ref); else announceWinner(entries[0].ref);
    return;
  }

  const elim = modeOf(phase()) === 'elim';
  state.spinning = true;
  W.highlight = null;
  buildSegments(entries);
  drawWheelCache();
  renderAll();

  const r = rand();
  let acc = 0, idx = W.segs.length - 1;
  for (let i = 0; i < W.segs.length; i++) { acc += W.segs[i].prob; if (r < acc) { idx = i; break; } }

  // Раунды выбывания зрителей короче, финал из двух — с полной длительностью
  let dur = games ? S().gameSpinDuration : S().spinDuration;
  if (!games && elim && entries.length > 2) dur = S().playerElimDuration;
  dur = clamp(+dur || 10, 1, 600);
  Sound.start();
  await animateTo(idx, dur * 1000, S().easing);

  const seg = W.segs[idx];
  setLiveName(seg.e.label, seg.e.color || seg.color);
  W.highlight = { idx, kind: elim ? 'out' : 'win', t0: performance.now() };
  state.spinning = false;

  if (elim) await eliminate(seg.e);
  else if (games) { state.transitioning = true; renderAll(); await sleep(900); chooseGame(seg.e.ref); }
  else announceWinner(seg.e.ref);
}

// Выбывание на любом из колёс: игра или зритель
async function eliminate(e) {
  const games = phase() === 'games';
  // Пока идёт анимация выбывания, новый спин запускать нельзя
  state.transitioning = true;
  Sound.elim();
  toast(`💥 ${e.label} выбывает!`, 'elim');
  renderAll();
  await sleep(1400);
  (games ? state.round.eliminated : state.round.out).push(e.key);
  W.highlight = null;
  const left = games ? gamePool() : playerPool();
  if (left.length === 1) {
    renderAll(true);
    await sleep(500);
    if (games) chooseGame(left[0]);
    else { state.transitioning = false; announceWinner(left[0]); }
    return;
  }
  state.transitioning = false;
  renderAll(true);
  if (S().autoContinue && !state.paused && left.length > 1) {
    await sleep(1300);
    const same = phase() === (games ? 'games' : 'players') && modeOf(phase()) === 'elim';
    if (same && !state.spinning && !state.pending && !state.paused && !state.transitioning) spin();
  }
}

// Осталась одна игра — показываем её и переходим к колесу участников
async function chooseGame(g) {
  state.transitioning = true;
  Sound.reveal();
  if (S().confetti) Confetti.burst(innerWidth / 2, innerHeight * 0.4, 120, TAU, 0, 13);
  const box = $('#chosenGame');
  box.replaceChildren(
    el('div', { class: 'cg-cover' }, imgOrPh(gameImage(g), g.title)),
    el('div', { class: 'winner-label', text: 'РАЗЫГРЫВАЕМ' }),
    el('div', { class: 'chosen-title', text: g.title }),
    el('div', { class: 'note', style: 'margin:8px 0 0', text: `${eligible(g).length} ${plural(eligible(g).length, 'претендент', 'претендента', 'претендентов')} · теперь крутим, кто её получит` }));
  openModal('gameModal');
  await sleep(3200);
  closeModal('gameModal');
  state.round = { phase: 'players', gameId: g.id, eliminated: state.round.eliminated, out: [], rerolled: [] };
  state.lastWonId = null;
  state.transitioning = false;
  W.highlight = null;
  renderAll(true);
}

let confirmTimer = null;

function announceWinner(p) {
  const g = selectedGame();
  state.pending = { p, g, confirmed: false, deadline: Date.now() + S().confirmSeconds * 1000 };
  const idx = W.segs.findIndex(s => s.e && s.e.key === p.login);
  if (idx >= 0) W.highlight = { idx, kind: 'win', t0: performance.now() };
  setLiveName('🏆 ' + p.name, p.color);
  Sound.win();
  Confetti.celebrate();

  const name = $('#winName');
  name.textContent = p.name;
  name.style.color = p.color;
  const wg = $('#winGame');
  wg.replaceChildren();
  if (g) {
    const img = gameImage(g);
    if (img) wg.append(el('img', { src: img, alt: '' }));
    wg.append(el('div', {},
      el('div', { class: 'wg-title', text: g.title }),
      el('div', { class: 'wg-sub', text: [g.platform, g.count > 1 ? `ключ ${gameResults(g).length + 1} из ${g.count}` : ''].filter(Boolean).join(' · ') || 'приз' })));
    wg.style.display = '';
  } else wg.style.display = 'none';

  const box = $('#confirmBox');
  box.className = 'confirm-box';
  $('#confirmMsg').textContent = '';
  clearInterval(confirmTimer);
  if (S().confirmEnabled) {
    box.classList.add('show');
    $('#confirmStatus').textContent = `${p.name}, напиши что-нибудь в чат!`;
    const total = S().confirmSeconds * 1000;
    const upd = () => {
      const pd = state.pending;
      if (!pd || pd.confirmed) return clearInterval(confirmTimer);
      const left = Math.max(0, pd.deadline - Date.now());
      $('#confirmSec').textContent = Math.ceil(left / 1000);
      $('#confirmBar').style.strokeDashoffset = 106.8 * (1 - left / total);
      if (!left) {
        clearInterval(confirmTimer);
        box.classList.add('late');
        $('#confirmStatus').textContent = '⌛ Время вышло — можно перекрутить';
      }
    };
    upd();
    confirmTimer = setInterval(upd, 250);
  }
  openModal('winnerModal');
  renderAll();
}

function onWinnerChat(m) {
  const pd = state.pending;
  if (!pd || pd.p.login !== m.login) return;
  $('#confirmMsg').textContent = m.text.slice(0, 200);
  if (!S().confirmEnabled || pd.confirmed) return;
  if (Date.now() > pd.deadline) return;
  pd.confirmed = true;
  clearInterval(confirmTimer);
  const box = $('#confirmBox');
  box.classList.remove('late');
  box.classList.add('ok');
  $('#confirmBar').style.strokeDashoffset = 0;
  $('#confirmSec').textContent = '✓';
  $('#confirmStatus').textContent = '✅ Победитель на месте!';
  Sound.join();
}

function acceptWinner() {
  const pd = state.pending;
  if (!pd) return;
  const { p, g } = pd;
  const key = g ? g.id : '_';
  (state.results[key] = state.results[key] || []).push({ login: p.login, name: p.name, color: p.color, at: Date.now() });
  saveResults();
  closeWinner();
  resetRound();
  state.lastWonId = g ? g.id : null;
  toast(`🏆 ${p.name} получает ${g ? g.title : 'приз'}!`, 'ok');
  renderAll(true);
}

function rerollWinner() {
  const pd = state.pending;
  if (!pd) return;
  closeWinner();
  state.round.rerolled.push(pd.p.login);
  // На выбывание перекрученный был последним — начинаем выбывание заново без него
  state.round.out = [];
  toast(`🔄 ${pd.p.name} исключён из этого розыгрыша`, 'warn');
  renderAll(true);
}

function closeWinner() {
  clearInterval(confirmTimer);
  state.pending = null;
  W.highlight = null;
  closeModal('winnerModal');
}

/* =====================================================================
   Twitch чат (анонимное чтение через IRC WebSocket — без авторизации)
   ===================================================================== */
const Twitch = {
  ws: null, channel: '', retry: null, manual: false, delay: 2000,
  connect(channel) {
    this.disconnect();
    this.channel = String(channel || '').trim().toLowerCase().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').split(/[/?]/)[0];
    if (!this.channel) { setStatus('offline'); return; }
    this.manual = false;
    setStatus('connecting');
    const ws = this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK justinfan' + (10000 + Math.floor(Math.random() * 80000)));
      ws.send('JOIN #' + this.channel);
    };
    ws.onmessage = e => String(e.data).split('\r\n').forEach(l => l && this.line(l));
    ws.onerror = () => setStatus('error');
    ws.onclose = () => {
      if (this.ws !== ws) return;
      setStatus(this.manual ? 'offline' : 'connecting');
      if (!this.manual) {
        this.retry = setTimeout(() => this.connect(this.channel), this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
      }
    };
  },
  disconnect() {
    this.manual = true;
    clearTimeout(this.retry);
    if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch {} }
  },
  line(raw) {
    if (raw.startsWith('PING')) { this.ws && this.ws.send('PONG :tmi.twitch.tv'); return; }
    let rest = raw, tags = {}, prefix = '';
    if (rest[0] === '@') {
      const sp = rest.indexOf(' ');
      for (const kv of rest.slice(1, sp).split(';')) {
        const i = kv.indexOf('=');
        tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
      }
      rest = rest.slice(sp + 1);
    }
    if (rest[0] === ':') { const sp = rest.indexOf(' '); prefix = rest.slice(1, sp); rest = rest.slice(sp + 1); }
    const ti = rest.indexOf(' :');
    const params = ti >= 0 ? rest.slice(0, ti) : rest;
    const text = ti >= 0 ? rest.slice(ti + 2) : '';
    const cmd = params.split(' ')[0];

    if (cmd === 'ROOMSTATE') { this.delay = 2000; setStatus('online'); return; }
    if (cmd === 'NOTICE' && /unsuccessful|suspended|does not exist/i.test(text)) { setStatus('error'); toast('Twitch: ' + text, 'warn'); return; }
    if (cmd !== 'PRIVMSG') return;

    const login = prefix.split('!')[0].toLowerCase();
    const badges = tags.badges || '';
    let msg = text;
    if (msg.startsWith('\u0001ACTION ')) msg = msg.slice(8, -1);
    onChat({
      login,
      name: tags['display-name'] || login,
      color: tags.color || '',
      text: msg,
      sub: tags.subscriber === '1' || /(^|,)(subscriber|founder)\//.test(badges),
      mod: tags.mod === '1',
      vip: /(^|,)vip\//.test(badges),
      broadcaster: /(^|,)broadcaster\//.test(badges),
    });
  },
};

function setStatus(st) {
  const d = $('#twStatus');
  d.className = 'status-dot ' + st;
  d.title = { online: 'Чат подключён', connecting: 'Подключение…', error: 'Ошибка подключения', offline: 'Не подключено' }[st];
  $('#connectBtn').textContent = st === 'online' ? 'Отключить' : st === 'connecting' ? 'Отмена' : 'Подключить';
}

function onChat(m) {
  onWinnerChat(m);
  const [first, ...args] = m.text.trim().split(/\s+/);
  const cmd = (first || '').toLowerCase();
  if (cmd === S().joinCmd.trim().toLowerCase()) handleJoin(m, args);
  else if (cmd === S().leaveCmd.trim().toLowerCase()) handleLeave(m.login);
}

function nameColor(login, tagColor) {
  if (/^#[0-9a-f]{6}$/i.test(tagColor)) {
    const n = parseInt(tagColor.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    if (lum > 0.35) return tagColor;
  }
  let h = 0;
  for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 85% 68%)`;
}

function parseGameChoice(args) {
  if (!S().allowChoice || !state.games.length) return 'all';
  const nums = args.join(' ').split(/[\s,;]+/).filter(Boolean);
  if (!nums.length || /^(all|все|всё|\*)$/i.test(nums[0])) return 'all';
  const ids = [];
  for (const n of nums) {
    const g = state.games[parseInt(n.replace(/^#/, ''), 10) - 1];
    if (g && !ids.includes(g.id)) ids.push(g.id);
  }
  if (!ids.length) return null;
  const max = parseInt(S().maxChoices, 10) || 0;
  return max > 0 ? ids.slice(0, max) : ids;
}

function handleJoin(m, args) {
  if (!state.regOpen) return;
  if (S().excludeBroadcaster && m.broadcaster) return;
  const games = parseGameChoice(args);
  if (!games) return;
  const prev = state.participants[m.login];
  state.participants[m.login] = {
    login: m.login,
    name: m.name,
    color: nameColor(m.login, m.color),
    sub: m.sub, mod: m.mod, vip: m.vip,
    games,
    joinedAt: prev ? prev.joinedAt : Date.now(),
    isNew: !prev,
  };
  saveParticipants();
  if (!prev) bumpCount();
  renderAll(true);
}

function handleLeave(login) {
  if (!state.participants[login]) return;
  delete state.participants[login];
  saveParticipants();
  renderAll(true);
}

/* =====================================================================
   Рендер
   ===================================================================== */
let renderQueued = false, rebuildQueued = false;
function renderAll(rebuild = false) {
  rebuildQueued = rebuildQueued || rebuild;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderGames();
    renderStage(rebuildQueued);
    renderPeople();
    renderElimBar();
    rebuildQueued = false;
  });
}

function imgOrPh(src, title) {
  if (!src) return el('div', { class: 'ph', text: (title || '?').slice(0, 2).toUpperCase() });
  const img = el('img', { src, alt: '', loading: 'lazy' });
  img.onerror = () => img.replaceWith(el('div', { class: 'ph', text: (title || '?').slice(0, 2).toUpperCase() }));
  return img;
}

let lastTopGame = null;
function renderGames() {
  const box = $('#gamesList');
  const people = Object.values(state.participants);
  box.replaceChildren();
  if (!state.games.length) {
    box.append(el('div', { class: 'empty', text: 'Список игр пуст. Нажмите ✏️, чтобы добавить игры — или крутите колесо без игр по всем участникам.' }));
    return;
  }
  const cur = selectedGame();
  const alive = new Set(gamePool().map(g => g.id));
  const out = new Set(state.round.eliminated);
  // Выбранная колесом игра — первой в списке (номер #N у неё остаётся прежним).
  // После победы там остаётся только что разыгранная игра, пока колесо не выберет следующую.
  const top = cur || state.games.find(g => g.id === state.lastWonId) || null;
  const order = state.games.map((g, i) => [g, i]);
  if (top) order.sort((a, b) => (b[0] === top) - (a[0] === top));
  if (top !== lastTopGame) {
    lastTopGame = top;
    if (top) box.scrollTo({ top: 0, behavior: 'smooth' });
  }
  order.forEach(([g, i]) => {
    const res = gameResults(g);
    const done = res.length >= g.count;
    const fans = people.filter(p => wantsGame(p, g)).length;
    let st = '';
    if (done) st = ' done';
    else if (cur === g) st = ' selected';
    else if (out.has(g.id)) st = ' out';
    else if (!alive.has(g.id)) st = ' nofans';
    box.append(el('div', {
      class: `game-card${st}`,
      style: `animation-delay:${i * 40}ms`,
      title: st === ' nofans' ? 'Никто не выбрал эту игру — её нет на колесе' : null,
    },
      el('div', { class: 'game-img' }, imgOrPh(gameImage(g), g.title)),
      el('div', { class: 'game-num', text: '#' + (i + 1) }),
      g.count > 1 ? el('div', { class: 'game-keys', text: `🔑 ${res.length}/${g.count}` }) : null,
      el('div', { class: 'game-body' },
        el('div', { class: 'game-title', text: g.title }),
        el('div', { class: 'game-meta', text: `👥 ${fans} ${plural(fans, 'участник', 'участника', 'участников')}${g.platform ? ' · ' + g.platform : ''}` })),
      res.length ? el('div', { class: 'game-winners' }, res.map(w => el('span', { class: 'winner-chip', text: '🏆 ' + w.name }))) : null,
    ));
  });
}

function renderStage(rebuild) {
  const ph = phase();
  const g = selectedGame();
  const hasGames = state.games.length > 0;

  $('#stage').classList.toggle('spinning', state.spinning);
  const entries = wheelEntries();
  if (!state.spinning && !state.pending && (rebuild || W.empty !== !entries.length)) {
    if (!W.highlight) {
      buildSegments(entries);
      drawWheelCache();
      W.lastIdx = -1;
    }
  }

  const btn = $('#spinBtn');
  btn.disabled = state.spinning || state.transitioning || !entries.length;
  $('#spinLabel').textContent = state.spinning ? '•••' : 'КРУТИТЬ';

  if (!state.spinning && !state.transitioning && !W.highlight) {
    const n = entries.length;
    const ln = $('#liveName');
    ln.className = 'live-name idle';
    ln.style.color = '';
    const waiting = `Ждём участников — пишите ${S().joinCmd}${S().allowChoice && hasGames ? ' [номера игр]' : ''} в чат`;
    const elim = modeOf(ph) === 'elim';
    if (ph === 'games') {
      if (n) ln.textContent = `На колесе ${n} ${plural(n, 'игра', 'игры', 'игр')} — ${elim ? 'каждый спин выбивает одну' : 'на какой остановится, ту и разыграем'}`;
      else if (!state.games.some(x => !gameDone(x))) ln.textContent = 'Все игры разыграны 🎉';
      else if (!Object.keys(state.participants).length) ln.textContent = waiting;
      else ln.textContent = 'Никто не записался на оставшиеся игры';
    } else if (!n) ln.textContent = g ? 'Никто из участников не выбрал эту игру' : waiting;
    else ln.textContent = `${n} ${plural(n, 'претендент', 'претендента', 'претендентов')}${g ? ' на ' + g.title : ''} — ${elim ? 'выбывают по одному, последний забирает игру' : 'один спин решает всё'}`;
  }

  $('#steps').style.display = hasGames ? '' : 'none';
  $$('#steps [data-step]').forEach(s => s.classList.toggle('active', s.dataset.step === ph));
  $$('#steps [data-mode-for]').forEach(b => {
    const elim = modeOf(b.dataset.modeFor) === 'elim';
    b.textContent = elim ? '💥 на выбывание' : '🎯 кто выпал';
    b.title = elim ? 'Каждый спин убирает одного, последний — победитель. Нажмите, чтобы переключить' : 'Где остановилось — тот и выиграл. Нажмите, чтобы переключить';
    b.disabled = state.spinning || state.transitioning || !!state.pending;
  });
  // Без игр есть только колесо зрителей — его режим показываем отдельно
  $('#soloMode').style.display = hasGames ? 'none' : '';
}

function setLiveName(text, color) {
  const ln = $('#liveName');
  ln.className = 'live-name';
  ln.textContent = text;
  ln.style.color = color || '';
}

function gamesLabel(p) {
  if (p.games === 'all') return state.games.length ? 'все игры' : 'участвует';
  const nums = p.games.map(id => state.games.findIndex(g => g.id === id) + 1).filter(n => n > 0);
  return nums.length ? 'игры: ' + nums.map(n => '#' + n).join(' ') : 'нет активных игр';
}

function renderPeople() {
  const all = Object.values(state.participants).sort((a, b) => b.joinedAt - a.joinedAt);
  $('#pCount').textContent = all.length;
  const q = $('#peopleSearch').value.trim().toLowerCase();
  // На этапе игр «в игре» все, кто хочет хоть одну из оставшихся игр
  const onWheel = new Set(phase() === 'players'
    ? playerPool().map(p => p.login)
    : gamePool().flatMap(g => eligible(g).map(p => p.login)));
  const out = new Set([...state.round.out, ...state.round.rerolled]);
  const winners = winnersSet();
  const list = $('#peopleList');
  list.replaceChildren();
  const shown = q ? all.filter(p => p.name.toLowerCase().includes(q) || p.login.includes(q)) : all;
  if (!shown.length) {
    list.append(el('div', { class: 'empty', text: q ? 'Никого не найдено' : 'Пока никто не зарегистрировался' }));
  }
  for (const p of shown.slice(0, 500)) {
    const row = el('div', {
      class: `person${p.isNew ? ' new' : ''}${onWheel.has(p.login) ? '' : ' dim'}${out.has(p.login) ? ' out' : ''}`,
      title: onWheel.has(p.login) ? null : 'Сейчас не участвует (не выбрал эту игру, уже выиграл или перекручен)',
    },
      el('div', { class: 'avatar', style: `--c:${p.color}`, text: (p.name[0] || '?').toUpperCase() }),
      el('div', { class: 'p-main' },
        el('div', { class: 'p-name', style: `color:${p.color}` }, p.name,
          winners.has(p.login) ? el('span', { class: 'badge', title: 'Победитель', text: '🏆' }) : null,
          p.sub ? el('span', { class: 'badge', title: 'Подписчик', text: '⭐' }) : null,
          p.mod ? el('span', { class: 'badge', title: 'Модератор', text: '🛡️' }) : null,
          p.vip ? el('span', { class: 'badge', title: 'VIP', text: '💎' }) : null),
        el('div', { class: 'p-games', text: gamesLabel(p) })),
      el('button', { class: 'x', title: 'Удалить', text: '✕', onclick: () => handleLeave(p.login) }),
    );
    list.append(row);
    p.isNew = false;
  }

  const hint = $('#joinHint');
  const jc = S().joinCmd;
  hint.replaceChildren(state.regOpen
    ? el('span', {}, 'Регистрация: ', el('code', { text: jc }),
      S().allowChoice && state.games.length ? el('span', {}, ' или ', el('code', { text: `${jc} 1 3` }), ' — только выбранные игры') : null)
    : el('span', { text: '🔒 Регистрация закрыта' }));

  const rt = $('#regToggle');
  rt.classList.toggle('closed', !state.regOpen);
  rt.textContent = state.regOpen ? 'Регистрация открыта' : 'Регистрация закрыта';
}

function renderElimBar() {
  const bar = $('#elimBar');
  const ph = phase();
  const hasGames = state.games.length > 0;
  const elim = modeOf(ph) === 'elim';
  const show = hasGames || elim;
  bar.classList.toggle('show', show);
  if (!show) return;
  const busy = state.spinning || state.transitioning || !!state.pending;
  const nameOf = l => (state.participants[l] || { name: l }).name;

  // Что уже выбыло, сколько осталось и подсказка — для текущего колеса
  const outKeys = ph === 'games' ? state.round.eliminated : state.round.out;
  const alive = ph === 'games' ? gamePool().length : playerPool().length;
  const outNames = ph === 'games'
    ? outKeys.map(id => (state.games.find(g => g.id === id) || { title: id }).title)
    : outKeys.map(nameOf);
  const total = alive + outKeys.length;
  const pct = total > 1 ? outKeys.length / (total - 1) * 100 : 0;
  const hint = ph === 'games'
    ? (elim ? 'каждый спин выбивает одну игру' : 'на какой игре остановится — ту и разыгрываем')
    : (elim ? 'выбывают по одному, последний забирает игру' : 'один спин — и победитель получает игру');
  const rer = ph === 'players' ? state.round.rerolled.map(nameOf) : [];

  let head;
  if (ph === 'games') head = el('div', { class: 'alive' }, 'Игр: ', el('b', { text: String(alive) }), total !== alive ? ` из ${total}` : '');
  else {
    const g = selectedGame();
    head = [
      g ? el('div', { class: 'thumb' }, imgOrPh(gameImage(g), g.title)) : null,
      el('div', { class: 'alive' }, el('b', { text: g ? g.title : 'Все участники' }),
        g && g.count > 1 ? ` · ключ ${gameResults(g).length + 1}/${g.count}` : '',
        elim ? ` · осталось ${alive}` : ''),
    ];
  }

  const chips = [
    ...outNames.map(n => el('span', { class: 'out-chip', text: n })),
    ...(rer.length ? ['перекручены:', ...rer.map(n => el('span', { class: 'out-chip', text: n }))] : []),
  ];

  // Полоска прогресса нужна только на выбывание (replaceChildren вывел бы null текстом)
  const progress = elim ? [el('div', { class: 'elim-progress' }, el('i', { style: `width:${clamp(pct, 0, 100)}%` }))] : [];
  bar.replaceChildren(
    ...progress,
    el('div', { class: 'elim-top' },
      head,
      el('div', { class: 'out-list' }, chips.length ? chips : el('span', { class: 'muted', text: hint })),
      elim ? el('button', {
        class: 'btn btn-mini', text: state.paused || !S().autoContinue ? '▶ Авто: выкл' : '⏸ Авто: вкл',
        title: 'Автоматически крутить следующий раунд',
        onclick: () => {
          if (!S().autoContinue) { setSetting('autoContinue', true); state.paused = false; }
          else state.paused = !state.paused;
          renderAll();
          if (!state.paused && outKeys.length && !state.spinning && !state.transitioning && !state.pending && alive > 1) spin();
        },
      }) : null,
      hasGames || outKeys.length || rer.length ? el('button', {
        class: 'btn btn-mini', disabled: busy,
        text: ph === 'games' || !hasGames ? '↺ Заново' : '↺ Заново выбрать игру',
        onclick: () => { resetRound(); renderAll(true); },
      }) : null),
  );
}

function bumpCount() {
  const c = $('#pCount');
  c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
}

/* =====================================================================
   Тосты и модалки
   ===================================================================== */
function toast(text, type = '') {
  const t = el('div', { class: 'toast ' + type, text });
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 400); }, 3800);
}

function openModal(id) { $('#' + id).classList.add('open'); }
function closeModal(id) { $('#' + id).classList.remove('open'); }

/* =====================================================================
   Настройки
   ===================================================================== */
const OUT_FMT = {
  spinDuration: v => `${v} с`,
  gameSpinDuration: v => `${v} с`,
  playerElimDuration: v => `${v} с`,
  confirmSeconds: v => `${v} с`,
  subLuck: v => (+v === 1 ? 'как у всех' : `×${v}`),
  volume: v => `${Math.round(v * 100)}%`,
};

function setSetting(key, v) {
  const prev = state.settings[key];
  if (/Mode$/.test(key) && (state.spinning || state.transitioning || state.pending)) {
    syncSettingsUI();
    toast('Режим можно сменить, когда колесо остановится', 'warn');
    return;
  }
  state.settings[key] = v;
  store.set('settings', state.settings);
  // Смена режима колеса сбрасывает прогресс выбывания на этом колесе
  if (prev !== v && key === 'gameMode') state.round.eliminated = [];
  if (prev !== v && key === 'playerMode') state.round.out = [];
  syncSettingsUI();
  renderAll(['subsOnly', 'subLuck', 'winnersCanRepeat', 'allowChoice', 'skipEmptyGames', 'gameMode', 'playerMode'].includes(key));
}

function toggleMode(ph) {
  if (state.spinning || state.transitioning || state.pending) return;
  const key = ph === 'games' ? 'gameMode' : 'playerMode';
  setSetting(key, S()[key] === 'elim' ? 'pick' : 'elim');
}

function syncSettingsUI() {
  $$('[data-setting]').forEach(inp => {
    const v = state.settings[inp.dataset.setting];
    if (inp.type === 'checkbox') inp.checked = !!v;
    else if (document.activeElement !== inp || inp.type === 'range') inp.value = v;
  });
  $$('[data-out]').forEach(o => {
    const k = o.dataset.out;
    o.textContent = (OUT_FMT[k] || String)(state.settings[k]);
  });
  $$('.jc').forEach(c => { c.textContent = c.textContent.replace(/^\S+/, S().joinCmd); });
  $$('.lc').forEach(c => { c.textContent = S().leaveCmd; });
}

function bindSettings() {
  $$('[data-setting]').forEach(inp => {
    const ev = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(ev, () => {
      let v;
      if (inp.type === 'checkbox') v = inp.checked;
      else if (inp.type === 'range' || inp.type === 'number') { v = parseFloat(inp.value); if (isNaN(v)) return; }
      else { v = inp.value; if (/Cmd$/.test(inp.dataset.setting) && !v.trim()) return; }
      setSetting(inp.dataset.setting, v);
    });
  });
  syncSettingsUI();
}

/* =====================================================================
   Редактор игр
   ===================================================================== */
let draft = [];

function openGamesEditor() {
  draft = state.games.map(g => ({ ...g }));
  renderEditor();
  openModal('gamesModal');
}

function renderEditor() {
  const box = $('#gamesEditor');
  box.replaceChildren(el('div', { class: 'ge-row head' },
    el('span', { text: '№' }), el('span', { text: 'Название' }), el('span', { text: 'На колесе (коротко)' }), el('span', { text: 'Steam App ID' }),
    el('span', { text: 'Картинка (URL, необязательно)' }), el('span', { text: 'Платформа' }), el('span', { text: 'Ключей' }), el('span')));
  draft.forEach((g, i) => {
    const inp = (key, ph, type = 'text') => el('input', {
      type, value: g[key] ?? '', placeholder: ph, min: type === 'number' ? 1 : null,
      oninput: e => { g[key] = type === 'number' ? parseInt(e.target.value, 10) || 1 : e.target.value; },
    });
    const move = d => {
      const j = i + d;
      if (j < 0 || j >= draft.length) return;
      [draft[i], draft[j]] = [draft[j], draft[i]];
      renderEditor();
    };
    box.append(el('div', { class: 'ge-row' },
      el('span', { class: 'ge-num', text: '#' + (i + 1) }),
      inp('title', 'Название игры'), inp('short', 'необязательно'), inp('steamAppId', 'напр. 1145350'),
      inp('image', 'https://…/cover.jpg'), inp('platform', 'Steam'), inp('count', '1', 'number'),
      el('div', { class: 'ge-btns' },
        el('button', { title: 'Выше', text: '↑', onclick: () => move(-1) }),
        el('button', { title: 'Ниже', text: '↓', onclick: () => move(1) }),
        el('button', { title: 'Удалить', text: '🗑', onclick: () => { draft.splice(i, 1); renderEditor(); } }))));
  });
  if (!draft.length) box.append(el('div', { class: 'empty', text: 'Пока пусто — добавьте первую игру' }));
}

function cleanDraft() {
  return draft.filter(g => String(g.title || '').trim()).map(g => {
    const o = { title: g.title.trim() };
    if (g.id && g.id !== o.title.toLowerCase()) o.id = g.id;
    if (String(g.short || '').trim()) o.short = g.short.trim();
    if (String(g.steamAppId || '').trim()) o.steamAppId = String(g.steamAppId).trim();
    if (String(g.image || '').trim()) o.image = g.image.trim();
    if (String(g.platform || '').trim()) o.platform = g.platform.trim();
    if ((g.count || 1) > 1) o.count = g.count;
    return o;
  });
}

function downloadJSON(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* =====================================================================
   Тексты для чата
   ===================================================================== */
function announceText() {
  const jc = S().joinCmd;
  let t = `🎁 РОЗЫГРЫШ! Пиши в чат ${jc}`;
  if (S().allowChoice && state.games.length) {
    t += ` — участвуешь во всех играх, или ${jc} и номера игр (например ${jc} 1 3).`;
    const max = parseInt(S().maxChoices, 10) || 0;
    if (max) t += ` Максимум игр: ${max}.`;
    t += ' Игры: ' + state.games.filter(g => !gameDone(g)).map(g => `${gameNumber(g)}) ${g.title}`).join(' | ');
  } else if (state.games.length) {
    t += ' чтобы участвовать! Разыгрываем: ' + state.games.filter(g => !gameDone(g)).map(g => g.title).join(', ');
  } else t += ' чтобы участвовать!';
  if (S().subsOnly) t += ' Только для сабов!';
  if (S().leaveCmd) t += `. Передумал — ${S().leaveCmd}`;
  return t.length > 500 ? t.slice(0, 497) + '…' : t;
}

function resultsText() {
  const lines = [];
  state.games.forEach(g => gameResults(g).forEach(w => lines.push(`${g.title} — ${w.name}`)));
  (state.results._ || []).forEach(w => lines.push(`Приз — ${w.name}`));
  return lines.length ? '🏆 Победители: ' + lines.join(' | ') : '';
}

async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg, 'ok'); }
  catch { prompt('Скопируйте текст:', text); }
}

/* =====================================================================
   Тестовые участники
   ===================================================================== */
const FAKE = ['Kappa_King', 'ПельменьТВ', 'xX_Slayer_Xx', 'NightOwl', 'Банан42', 'PogChampion', 'Lunar_Fox', 'КотВСапогах',
  'ShadowByte', 'MegaMind', 'Чайный_Гриб', 'PixelPirate', 'StreamSniper', 'Zefirka', 'TurboSnail', 'Mr_Potato', 'Ёжик_в_тумане',
  'NoScopeNinja', 'CozyGamer', 'Darkness99', 'Валера_Про', 'GlitchHunter', 'Skyline', 'Мандаринка', 'FrostBite'];

function addFake(n = 15) {
  const free = FAKE.filter(f => !state.participants[f.toLowerCase()]);
  for (let i = 0; i < n; i++) {
    const name = free[i] || 'Viewer' + Math.floor(rand() * 100000);
    let games = 'all';
    if (state.games.length && S().allowChoice && rand() < 0.6) {
      games = state.games.filter(() => rand() < 0.5).map(g => g.id);
      if (!games.length) games = [state.games[0].id];
    }
    const login = name.toLowerCase();
    state.participants[login] = {
      login, name, color: nameColor(login, ''), games,
      sub: rand() < 0.3, mod: rand() < 0.08, vip: rand() < 0.1,
      joinedAt: Date.now() + i, isNew: true,
    };
  }
  saveParticipants();
  bumpCount();
  renderAll(true);
}

/* =====================================================================
   Запуск
   ===================================================================== */
function initStars() {
  const box = $('#stars');
  for (let i = 0; i < 60; i++) {
    box.append(el('i', { style: `left:${Math.random() * 100}%;top:${Math.random() * 100}%;animation-delay:${Math.random() * 4}s;animation-duration:${3 + Math.random() * 4}s` }));
  }
}

function bindUI() {
  $('#spinBtn').addEventListener('click', spin);
  $$('[data-mode-for]').forEach(b => b.addEventListener('click', () => toggleMode(b.dataset.modeFor)));
  $('#connectBtn').addEventListener('click', () => {
    const dot = $('#twStatus');
    if (dot.classList.contains('online') || dot.classList.contains('connecting')) {
      Twitch.disconnect();
      setStatus('offline');
      return;
    }
    const ch = $('#channelInput').value;
    setSetting('channel', ch.trim());
    Twitch.connect(ch);
  });
  $('#channelInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#connectBtn').click(); });

  $('#regToggle').addEventListener('click', () => {
    state.regOpen = !state.regOpen;
    store.set('regOpen', state.regOpen);
    toast(state.regOpen ? '🟢 Регистрация открыта' : '🔒 Регистрация закрыта', state.regOpen ? 'ok' : 'warn');
    renderAll();
  });
  $('#announceBtn').addEventListener('click', () => copy(announceText(), '📋 Текст скопирован — вставьте его в чат'));
  $('#resultsBtn').addEventListener('click', () => {
    const t = resultsText();
    if (!t) toast('Победителей пока нет', 'warn');
    else copy(t, '📋 Итоги скопированы');
  });
  $('#settingsBtn').addEventListener('click', () => openModal('settingsModal'));
  $('#helpBtn').addEventListener('click', () => openModal('helpModal'));
  $('#editGamesBtn').addEventListener('click', openGamesEditor);
  $('#testBtn').addEventListener('click', () => addFake(15));
  $('#clearPeopleBtn').addEventListener('click', () => {
    if (state.spinning || !Object.keys(state.participants).length) return;
    if (!confirm('Удалить всех участников?')) return;
    state.participants = {};
    saveParticipants();
    resetRound();
    renderAll(true);
  });
  $('#peopleSearch').addEventListener('input', () => renderAll());
  $('#manualForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#manualName').value.trim().replace(/^@/, '');
    if (!name) return;
    const prevOpen = state.regOpen;
    state.regOpen = true;
    handleJoin({ login: name.toLowerCase(), name, color: '', sub: false, mod: false, vip: false, broadcaster: false }, []);
    state.regOpen = prevOpen;
    $('#manualName').value = '';
  });

  $('#acceptBtn').addEventListener('click', acceptWinner);
  $('#rerollBtn').addEventListener('click', rerollWinner);

  $$('.modal').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m && !m.hasAttribute('data-sticky')) closeModal(m.id);
    });
  });
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.closest('.modal').id)));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('.modal.open:not([data-sticky])').forEach(m => closeModal(m.id));
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.code === 'Space' && !typing && !$('.modal.open')) { e.preventDefault(); spin(); }
  });

  // Сброс
  $('#resetResultsBtn').addEventListener('click', () => {
    if (!confirm('Сбросить всех победителей? Игры снова станут доступны для розыгрыша.')) return;
    state.results = {};
    saveResults();
    resetRound();
    renderAll(true);
    toast('Итоги сброшены', 'ok');
  });
  $('#resetRoundBtn2').addEventListener('click', () => { resetRound(); renderAll(true); toast('Раунд сброшен', 'ok'); });
  $('#resetAllBtn').addEventListener('click', () => {
    if (!confirm('Сбросить всё: участников, итоги, настройки и свой список игр?')) return;
    ['participants', 'results', 'settings', 'games', 'regOpen'].forEach(store.del);
    location.reload();
  });

  // Редактор игр
  $('#addGameBtn').addEventListener('click', () => { draft.push({ title: '', steamAppId: '', image: '', platform: 'Steam', count: 1 }); renderEditor(); });
  $('#saveGamesBtn').addEventListener('click', () => {
    const list = cleanDraft();
    store.set('games', list);
    setGames(list);
    closeModal('gamesModal');
    resetRound();
    renderAll(true);
    toast('Список игр сохранён в этом браузере', 'ok');
  });
  $('#exportGamesBtn').addEventListener('click', () => downloadJSON('games.json', cleanDraft()));
  $('#resetGamesBtn').addEventListener('click', async () => {
    store.del('games');
    await loadGames();
    draft = state.games.map(g => ({ ...g }));
    renderEditor();
    renderAll(true);
    toast('Загружен список из games.json', 'ok');
  });
  $('#importGames').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      draft = (Array.isArray(data) ? data : data.games).map(normGame);
      renderEditor();
    } catch { toast('Не получилось прочитать файл', 'warn'); }
    e.target.value = '';
  });
}

async function init() {
  initStars();
  Confetti.init();
  W.cv = $('#wheel');
  W.ctx = W.cv.getContext('2d');
  bindSettings();
  bindUI();
  await loadGames();

  new ResizeObserver(() => resizeWheel()).observe($('#wheelWrap'));
  resizeWheel();
  if (document.fonts) document.fonts.ready.then(() => drawWheelCache());
  renderAll(true);
  requestAnimationFrame(loop);

  const urlChannel = new URLSearchParams(location.search).get('channel');
  const ch = urlChannel || S().channel;
  if (urlChannel) setSetting('channel', urlChannel);
  $('#channelInput').value = ch || '';
  if (ch) Twitch.connect(ch);
  else setStatus('offline');

  if (!store.get('seenHelp', false)) {
    openModal('helpModal');
    store.set('seenHelp', true);
  }
}

init();
