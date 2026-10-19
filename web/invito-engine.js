// Invito engine — generative music, preview-image renderer, scratch card
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // midi -> Hz

export function createMusic() {
  let ac = null, master = null, delay = null, timer = null, step = 0, nextT = 0, track = null, audioEl = null, playing = null;
  const ensure = () => {
    if (ac) return;
    const AC = window.AudioContext || window.webkitAudioContext; ac = new AC();
    master = ac.createGain(); master.gain.value = 0.0; master.connect(ac.destination);
    delay = ac.createDelay(1.5); delay.delayTime.value = 0.33; const fb = ac.createGain(); fb.gain.value = 0.32; const wet = ac.createGain(); wet.gain.value = 0.28;
    delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);
  };
  const voice = (t, f, dur, { type = 'sine', gain = 0.2, attack = 0.01, release = null, lp = null, send = true, detune = 0 } = {}) => {
    const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); o.detune.value = detune;
    let node = o;
    if (lp) { const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; o.connect(fl); node = fl; }
    node.connect(g); g.connect(master); if (send) g.connect(delay);
    const rel = release ?? dur;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + rel);
    o.start(t); o.stop(t + attack + rel + 0.05);
  };
  let noiseBuf = null;
  const noise = (t, dur, { gain = 0.15, hp = 6000, bp = null } = {}) => {
    if (!noiseBuf) { noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const s = ac.createBufferSource(); s.buffer = noiseBuf; const f = ac.createBiquadFilter(); f.type = bp ? 'bandpass' : 'highpass'; f.frequency.value = bp || hp; const g = ac.createGain();
    s.connect(f); f.connect(g); g.connect(master); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); s.start(t); s.stop(t + dur + 0.02);
  };
  const kick = (t, gain = 0.5) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.4); };
  const chordsCF = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
  const TRACKS = {
    lullaby: { spb: 0.21, play: (t, s) => { const seq = [72, 76, 79, 84, 79, 76, 74, 77, 81, 86, 81, 77, 71, 74, 79, 83]; voice(t, NOTE(seq[s % 16]), 1.4, { gain: 0.16 }); voice(t, NOTE(seq[s % 16] + 12), 0.6, { gain: 0.03, type: 'triangle' }); if (s % 8 === 0) voice(t, NOTE(chordsCF[(s / 8 | 0) % 4][0] - 12), 2.2, { gain: 0.08, type: 'triangle', send: false }); } },
    waltz: { spb: 0.4, play: (t, s) => { const bar = (s / 3 | 0) % 4, b = s % 3, ch = chordsCF[bar]; if (b === 0) voice(t, NOTE(ch[0] - 24), 1.0, { gain: 0.22, type: 'triangle', send: false }); else ch.forEach((n) => voice(t, NOTE(n), 0.32, { gain: 0.06, type: 'sine' })); if (b === 0) { const mel = [76, 74, 72, 74][bar]; voice(t, NOTE(mel + 12), 1.1, { gain: 0.07, type: 'triangle' }); } } },
    lofi: { spb: 0.19, play: (t, s) => { const prog = [[65, 69, 72, 76], [64, 67, 71, 74], [62, 65, 69, 72], [60, 64, 67, 71]]; const bar = (s / 16 | 0) % 4; if (s % 16 === 0) prog[bar].forEach((n, i) => voice(t + i * 0.02, NOTE(n - 12), 2.9, { type: 'sawtooth', gain: 0.03, attack: 0.2, lp: 900, detune: (i - 1.5) * 6 })); if (s % 8 === 0) kick(t, 0.35); if (s % 8 === 4) noise(t, 0.12, { gain: 0.08, bp: 1800 }); if (s % 2 === 1) noise(t, 0.04, { gain: 0.03 }); if (s % 4 === 2 && Math.random() < 0.5) voice(t, NOTE(prog[bar][(Math.random() * 4) | 0] + 12), 0.5, { gain: 0.05, type: 'sine' }); } },
    celebration: { spb: 0.125, play: (t, s) => { const prog = [60, 67, 69, 65]; const bar = (s / 16 | 0) % 4, root = prog[bar], maj = bar === 2 ? [0, 3, 7] : [0, 4, 7]; if (s % 2 === 0) voice(t, NOTE(root - 24 + (s % 4 === 2 ? 12 : 0)), 0.22, { type: 'square', gain: 0.05, lp: 700, send: false }); if (s % 4 === 0) kick(t, 0.32); if (s % 8 === 4) noise(t, 0.15, { gain: 0.12, bp: 1500 }); noise(t, 0.03, { gain: 0.015 }); const arp = [0, 1, 2, 1]; voice(t, NOTE(root + 12 + maj[arp[s % 4]]), 0.18, { type: 'triangle', gain: 0.05 }); } },
    ambient: { spb: 0.5, play: (t, s) => { const pads = [[57, 64, 69, 72], [53, 60, 65, 69], [60, 67, 72, 76], [55, 62, 67, 71]]; if (s % 8 === 0) pads[(s / 8 | 0) % 4].forEach((n, i) => voice(t + i * 0.15, NOTE(n), 6, { type: 'sine', gain: 0.045, attack: 1.8 })); if (s % 3 === 1 && Math.random() < 0.6) voice(t, NOTE([81, 84, 88, 91][(Math.random() * 4) | 0]), 2.5, { gain: 0.025, attack: 0.05 }); } },
    oriental: { spb: 0.17, play: (t, s) => { const scale = [62, 63, 66, 67, 69, 70, 72, 74]; if (!this_.w) this_.w = 0; if (s % 2 === 0) { this_.w = Math.max(0, Math.min(7, this_.w + [-1, 1, 1, -1, 2, -2, 0][(Math.random() * 7) | 0])); voice(t, NOTE(scale[this_.w]), 0.45, { type: 'triangle', gain: 0.09, attack: 0.004 }); } if (s % 16 === 0) voice(t, NOTE(50), 3, { type: 'sawtooth', gain: 0.025, lp: 500, attack: 0.3, send: false }); const doira = [1, 0, 0, 2, 0, 2, 1, 0, 1, 0, 0, 2, 0, 2, 0, 2]; const h = doira[s % 16]; if (h === 1) { kick(t, 0.25); noise(t, 0.06, { gain: 0.06, bp: 300 }); } if (h === 2) noise(t, 0.07, { gain: 0.1, bp: 2600 }); } },
  };
  const this_ = {};
  const schedule = () => { if (!track) return; while (nextT < ac.currentTime + 0.25) { track.play(nextT, step++); nextT += track.spb; } };
  const api = {
    get playing() { return playing; },
    play(name, src) {
      api.stop();
      if (name === 'custom' && src) { audioEl = new Audio(src); audioEl.loop = true; audioEl.volume = 0.6; audioEl.play().catch(() => {}); playing = name; return; }
      if (!TRACKS[name]) return;
      ensure(); ac.resume(); track = TRACKS[name]; step = 0; nextT = ac.currentTime + 0.05;
      master.gain.cancelScheduledValues(ac.currentTime); master.gain.setValueAtTime(0.0001, ac.currentTime); master.gain.linearRampToValueAtTime(0.9, ac.currentTime + 1.2);
      timer = setInterval(schedule, 40); schedule(); playing = name;
    },
    stop() {
      if (audioEl) { audioEl.pause(); audioEl = null; }
      if (timer) { clearInterval(timer); timer = null; }
      if (ac && master) { master.gain.cancelScheduledValues(ac.currentTime); master.gain.setValueAtTime(master.gain.value, ac.currentTime); master.gain.linearRampToValueAtTime(0.0001, ac.currentTime + 0.4); }
      track = null; playing = null;
    },
  };
  return api;
}

// ---------- preview images ----------
const loadImg = (src) => new Promise((res) => { if (!src) return res(null); const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
const cover = (ctx, im, x, y, w, h) => { const r = Math.max(w / im.width, h / im.height); const iw = im.width * r, ih = im.height * r; ctx.drawImage(im, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih); };
function fitText(ctx, text, font, wt, maxW, maxLines, start, min) {
  for (let size = start; size >= min; size -= 4) {
    ctx.font = `${wt} ${size}px '${font}'`;
    const words = String(text).split(/\s+/); const lines = []; let line = '';
    for (const w of words) { const test = line ? line + ' ' + w : w; if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test; }
    if (line) lines.push(line);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { size, lines };
  }
  ctx.font = `${wt} ${min}px '${font}'`; return { size: min, lines: [String(text)] };
}
const spaced = (ctx, text, x, y, sp, align) => { if ('letterSpacing' in ctx) { ctx.letterSpacing = sp + 'px'; ctx.textAlign = align || 'left'; ctx.fillText(text, x, y); ctx.letterSpacing = '0px'; } else { ctx.textAlign = align || 'left'; ctx.fillText(text, x, y); } };

export async function renderCard({ W, H, th, names, kick, date, link, cover: src, tt }) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  try { await Promise.all([document.fonts.load(`${th.wt} 80px '${th.font}'`), document.fonts.load(`400 30px '${th.body}'`)]); } catch (e) {}
  const im = await loadImg(src);
  const shown = tt === 'uppercase' ? String(names).toUpperCase() : names;
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const land = W > H;
  const drawPhoto = (x, y, w, h) => { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, th.accent2); g.addColorStop(1, th.accent); ctx.fillStyle = g; ctx.fillRect(x, y, w, h); if (im) { try { ctx.filter = th.imgFilter || 'none'; } catch (e) {} cover(ctx, im, x, y, w, h); ctx.filter = 'none'; } ctx.restore(); };
  if (th.key === 'riso') { ctx.fillStyle = th.accent + '40'; for (let yy = 0; yy < H; yy += 14) for (let xx = (yy / 14) % 2 ? 7 : 0; xx < W; xx += 14) { ctx.beginPath(); ctx.arc(xx, yy, 2, 0, 6.28); ctx.fill(); } }
  if (th.key === 'minimal') { ctx.strokeStyle = th.line; ctx.lineWidth = 1; for (let xx = 0; xx < W; xx += W / 6) { ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, H); ctx.stroke(); } }
  if (th.key === 'luxe') { ctx.save(); ctx.translate(W * (land ? 0.72 : 0.5), H * (land ? 0.5 : 0.7)); ctx.strokeStyle = th.accent + '30'; for (let a = 0; a < 360; a += 7.5) { ctx.rotate(7.5 * Math.PI / 180); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.max(W, H), 0); ctx.stroke(); } ctx.restore(); }
  let tx, tw, ty, align = 'left';
  if (land) { drawPhoto(0, 0, W * 0.44, H); tx = W * 0.5; tw = W * 0.44; ty = H * 0.28; }
  else {
    drawPhoto(0, 0, W, H * 0.62);
    const g = ctx.createLinearGradient(0, H * 0.35, 0, H * 0.63); g.addColorStop(0, th.bg + '00'); g.addColorStop(1, th.bg); ctx.fillStyle = g; ctx.fillRect(0, H * 0.35, W, H * 0.28);
    tx = W / 2; tw = W * 0.84; ty = H * 0.66; align = 'center';
  }
  if (th.frame) { ctx.strokeStyle = th.accent; ctx.globalAlpha = 0.6; ctx.lineWidth = 2; ctx.strokeRect(24, 24, W - 48, H - 48); ctx.globalAlpha = 0.3; ctx.strokeRect(36, 36, W - 72, H - 72); ctx.globalAlpha = 1; }
  ctx.fillStyle = th.accent; ctx.font = `600 ${land ? 22 : 34}px '${th.body}'`; spaced(ctx, String(kick).toUpperCase(), tx, ty, land ? 6 : 9, align);
  const ft = fitText(ctx, shown, th.font, th.wt, tw, 3, land ? Math.round(110 * (th.fs || 1)) : Math.round(170 * (th.fs || 1)), 40);
  ctx.fillStyle = th.ink; ctx.textAlign = align; ctx.font = `${th.wt} ${ft.size}px '${th.font}'`;
  if (th.glow) { ctx.shadowColor = th.accent; ctx.shadowBlur = 30; }
  if (th.key === 'riso') { ctx.fillStyle = th.accent; ft.lines.forEach((l, i) => ctx.fillText(l, tx + ft.size * 0.06, ty + (land ? 40 : 70) + (i + 1) * ft.size * 0.95 + ft.size * 0.06)); ctx.fillStyle = th.ink; }
  ft.lines.forEach((l, i) => ctx.fillText(l, tx, ty + (land ? 40 : 70) + (i + 1) * ft.size * 0.95));
  ctx.shadowBlur = 0;
  const by = ty + (land ? 40 : 70) + ft.lines.length * ft.size * 0.95 + (land ? 60 : 110);
  // Ширина плашки с датой учитывает разрядку 2px, с которой текст рисуется (spaced), иначе конец даты («17:00») вылезает за плашку.
  // Без даты и времени (стёрты в конструкторе) плашки нет, а не пустой цветной прямоугольник.
  const DT = String(date || '').toUpperCase(), sp = 'letterSpacing' in ctx ? 2 : 0;
  if (DT) {
    ctx.font = `700 ${land ? 26 : 40}px '${th.body}'`; const dw = ctx.measureText(DT).width + sp * DT.length + (land ? 40 : 64); const dh = land ? 50 : 80;
    const dx = align === 'center' ? tx - dw / 2 : tx;
    ctx.fillStyle = th.accent; ctx.fillRect(dx, by - dh * 0.7, dw, dh); ctx.fillStyle = th.onAccent; ctx.textAlign = 'left'; spaced(ctx, DT, dx + (land ? 20 : 32), by + dh * 0.12, 2, 'left');
  }
  ctx.fillStyle = th.muted; ctx.font = `500 ${land ? 20 : 30}px 'JetBrains Mono', monospace`; ctx.textAlign = align; ctx.fillText(link, align === 'center' ? tx : tx, H - (land ? 40 : 90));
  try { return c.toDataURL('image/png'); } catch (e) { return null; }
}

// ---------- scratch card ----------
export function attachScratch(canvas, { color, color2, label, font, onDone }) {
  const ctx = canvas.getContext('2d'); let done = false, down = false, last = null, checkT = 0;
  const paint = () => {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, r.width, r.height); g.addColorStop(0, color); g.addColorStop(1, color2 || color); ctx.fillStyle = g; ctx.fillRect(0, 0, r.width, r.height);
    ctx.globalAlpha = 0.18; ctx.fillStyle = '#fff'; for (let i = 0; i < 260; i++) { ctx.beginPath(); ctx.arc(Math.random() * r.width, Math.random() * r.height, Math.random() * 1.6, 0, 6.28); ctx.fill(); } ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.font = `600 15px ${font || 'sans-serif'}`; ctx.textAlign = 'center'; ctx.fillText(label || 'Scratch', r.width / 2, r.height / 2 + 5);
  };
  paint();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const scratch = (p) => { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = 44; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo((last || p).x, (last || p).y); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.globalCompositeOperation = 'source-over'; last = p; };
  const check = () => { const w = canvas.width, h = canvas.height; const data = ctx.getImageData(0, 0, w, h).data; let clear = 0, n = 0; for (let i = 3; i < data.length; i += 4 * 40) { n++; if (data[i] < 20) clear++; } if (clear / n > 0.45 && !done) { done = true; canvas.style.transition = 'opacity .6s'; canvas.style.opacity = '0'; canvas.style.pointerEvents = 'none'; onDone && onDone(); } };
  const pd = (e) => { down = true; last = null; canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); scratch(pos(e)); };
  const pm = (e) => { if (!down) return; e.preventDefault(); scratch(pos(e)); const now = performance.now(); if (now - checkT > 150) { checkT = now; check(); } };
  const pu = () => { down = false; last = null; check(); };
  canvas.addEventListener('pointerdown', pd); canvas.addEventListener('pointermove', pm); window.addEventListener('pointerup', pu);
  return () => { canvas.removeEventListener('pointerdown', pd); canvas.removeEventListener('pointermove', pm); window.removeEventListener('pointerup', pu); };
}
