// Pixel office renderer. All art is drawn here from tiny pixel maps (original, made for noob_dev).
(function () {
  'use strict';
  const W = 320, H = 200, PX = 2; // sprite pixel = 2 canvas px
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const office = document.getElementById('office');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const C = {
    wall: '#161B22', wallLine: '#2A313C', floorA: '#10151C', floorB: '#121922',
    desk: '#2A313C', deskFront: '#1C222B', deskEdge: '#3A4350',
    skin: '#F2C9A0', skinShade: '#D9A77E', eye: '#0D1117',
    accent: '#A3E635', pop: '#F472B6', warn: '#FBBF24', red: '#F87171', text: '#E6EDF3', muted: '#8B949E',
    sky: '#0B1A2A', moon: '#E6EDF3', leaf: '#4D7C0F', leaf2: '#A3E635', pot: '#5E6570',
    cat: '#E8A15A', catDark: '#B9733A',
  };

  // 12x12 upper-body base. H hair, S skin, E eye, T shirt, G glasses frame, P headphone/hat
  const BASE = [
    '...HHHHHH...',
    '..HHHHHHHH..',
    '.HHHHHHHHHH.',
    '..HSSSSSSH..',
    '..SESSSSES..',
    '..SSSSSSSS..',
    '...SSSSSS...',
    '....SSSS....',
    '..TTTTTTTT..',
    '.TTTTTTTTTT.',
    'TTTTTTTTTTTT',
    'TTTTTTTTTTTT',
  ];
  function variant(kind) {
    const m = BASE.map((r) => r.split(''));
    const set = (y, x, ch) => { m[y][x] = ch; };
    if (kind === 'ui') { // long hair
      for (let y = 3; y <= 9; y++) { set(y, 1, 'H'); set(y, 10, 'H'); }
      for (let y = 6; y <= 9; y++) { set(y, 2, 'H'); set(y, 9, 'H'); }
    }
    if (kind === 'frontend') { // headphones
      for (let x = 2; x <= 9; x++) set(0, x, 'P');
      set(1, 1, 'P'); set(1, 10, 'P');
      for (let y = 2; y <= 5; y++) { set(y, 1, 'P'); set(y, 10, 'P'); }
    }
    if (kind === 'graphic') { // beanie
      for (let x = 3; x <= 8; x++) set(0, x, 'P');
      for (let x = 2; x <= 9; x++) set(1, x, 'P');
      for (let x = 1; x <= 10; x++) set(2, x, 'Q');
    }
    if (kind === 'reviewer') { // glasses
      m[4] = '..GEGSSGEG..'.split('');
    }
    return m;
  }

  const AGENTS = {
    ui:       { x: 84,  y: 92,  hair: '#3B2A3F', shirt: C.pop,    p: '#8B949E', q: '#8B949E', name: 'นักออกแบบ UI' },
    frontend: { x: 236, y: 92,  hair: '#2B2118', shirt: C.accent, p: '#5E6570', q: '#5E6570', name: 'Frontend' },
    graphic:  { x: 84,  y: 156, hair: '#6B3B1F', shirt: C.warn,   p: C.red,     q: '#B44B4B', name: 'นักออกแบบกราฟิก' },
    reviewer: { x: 236, y: 156, hair: '#8B949E', shirt: C.text,   p: '#5E6570', q: '#5E6570', name: 'ผู้ตรวจคุณภาพ' },
  };
  const status = {};
  for (const k in AGENTS) { AGENTS[k].map = variant(k); status[k] = { state: 'idle', bubble: '' }; }

  // DOM overlays
  for (const k in AGENTS) {
    const a = AGENTS[k];
    const b = document.createElement('div');
    b.className = 'bubble'; b.setAttribute('role', 'status');
    b.style.left = (a.x / W * 100) + '%'; b.style.top = ((a.y - 30) / H * 100) + '%';
    const pl = document.createElement('div');
    pl.className = 'plate'; pl.textContent = a.name;
    pl.style.left = (a.x / W * 100) + '%'; pl.style.top = ((a.y + 19) / H * 100) + '%';
    office.append(b, pl);
    a.bubbleEl = b; a.plateEl = pl;
  }

  function rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

  function drawRoom(t) {
    // floor
    for (let y = 44; y < H; y += 16) for (let x = 0; x < W; x += 16) rect(x, y, 16, 16, ((x + y) / 16) % 2 ? C.floorA : C.floorB);
    // wall
    rect(0, 0, W, 44, C.wall); rect(0, 42, W, 2, C.wallLine);
    // window with night sky
    rect(130, 8, 60, 28, C.wallLine); rect(132, 10, 56, 24, C.sky);
    rect(159, 10, 2, 24, C.wallLine);
    rect(176, 14, 6, 6, C.moon); rect(178, 14, 4, 4, C.sky);
    const stars = [[138, 14], [148, 22], [167, 13], [184, 28], [143, 29]];
    stars.forEach(([sx, sy], i) => { if (reduced || ((t >> 4) + i) % 5) rect(sx, sy, 1, 1, C.text); });
    // shelf
    rect(250, 14, 52, 3, C.deskEdge);
    const books = [C.pop, C.accent, C.warn, C.muted, C.red, C.text];
    books.forEach((c, i) => rect(254 + i * 7, 4, 5, 10, c));
    // clock
    rect(214, 10, 14, 14, C.wallLine); rect(216, 12, 10, 10, C.text); rect(220, 14, 1, 4, C.eye); rect(221, 17, 3, 1, C.eye);
    // plants
    plant(8, 52); plant(300, 52);
    // rug
    rect(120, 112, 80, 40, '#151C26'); rect(122, 114, 76, 36, '#18202B');
  }
  function plant(x, y) {
    rect(x + 2, y + 12, 10, 8, C.pot);
    rect(x + 5, y, 4, 12, C.leaf); rect(x, y + 4, 6, 4, C.leaf2); rect(x + 8, y + 2, 6, 4, C.leaf2); rect(x + 3, y - 2, 4, 3, C.leaf2);
  }

  function drawAgent(k, t) {
    const a = AGENTS[k], st = status[k].state;
    const working = st === 'working';
    const bob = reduced ? 0 : working ? ((t >> 2) % 2) : ((t >> 4) % 2);
    const blink = !reduced && (t % 70) < 3;
    const sx = a.x - 12, sy = a.y - 22 + bob;
    // chair back
    rect(a.x - 14, a.y - 10, 28, 12, '#0E1319');
    // body sprite
    const pal = { H: a.hair, S: C.skin, E: blink ? C.skin : C.eye, T: a.shirt, G: '#C9D1D9', P: a.p, Q: a.q };
    a.map.forEach((row, y) => row.forEach((ch, x) => { if (ch !== '.') rect(sx + x * PX, sy + y * PX, PX, PX, pal[ch]); }));
    // desk
    rect(a.x - 32, a.y, 64, 4, C.deskEdge); rect(a.x - 32, a.y + 4, 64, 12, C.desk); rect(a.x - 32, a.y + 14, 64, 2, C.deskFront);
    rect(a.x - 30, a.y + 16, 4, 4, C.deskFront); rect(a.x + 26, a.y + 16, 4, 4, C.deskFront);
    // laptop (back of lid faces us)
    rect(a.x - 9, a.y - 8, 18, 10, '#3A4350'); rect(a.x - 1, a.y - 4, 3, 1, working && (t >> 3) % 2 ? C.accent : C.muted);
    if (working) rect(a.x - 11, a.y - 9, 22, 1, 'rgba(163,230,53,.35)');
    // hands on desk
    const hl = working && !reduced ? ((t >> 1) % 2) : 0;
    rect(a.x - 14, a.y + 1 - hl, 4, 3, C.skin); rect(a.x + 10, a.y + 1 - (1 - hl) * (working ? 1 : 0), 4, 3, C.skin);
    // mug
    rect(a.x + 18, a.y - 3, 5, 5, k === 'reviewer' ? C.accent : C.text); rect(a.x + 23, a.y - 2, 2, 3, C.muted);
    if (working && !reduced && (t >> 3) % 3 === 0) rect(a.x + 19, a.y - 7, 1, 3, C.muted);
    // waiting "!"
    if (st === 'waiting' && (reduced || (t >> 3) % 2)) { rect(a.x + 13, a.y - 30, 3, 7, C.accent); rect(a.x + 13, a.y - 21, 3, 3, C.accent); }
  }

  function drawCat(t) {
    const x = 152, y = 178;
    rect(x, y, 16, 7, C.cat); rect(x + 12, y - 3, 7, 6, C.cat);
    rect(x + 12, y - 5, 2, 2, C.cat); rect(x + 17, y - 5, 2, 2, C.cat);
    rect(x + 2, y + 2, 8, 2, C.catDark); rect(x - 4, y + 4, 6, 2, C.cat);
    rect(x + 14, y - 1, 2, 1, C.eye); rect(x + 17, y - 1, 1, 1, C.eye);
    if (!reduced) { const z = (t >> 3) % 3; ctx.fillStyle = C.muted; ctx.font = '7px monospace'; ctx.fillText('z', x + 20 + z * 2, y - 6 - z * 3); }
  }

  let t = 0, last = 0;
  function frame(now) {
    if (now - last > 80) {
      last = now; t++;
      ctx.clearRect(0, 0, W, H);
      drawRoom(t);
      ['ui', 'frontend', 'graphic', 'reviewer'].forEach((k) => drawAgent(k, t));
      drawCat(t);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.Office = {
    set(key, state, bubble) {
      const a = AGENTS[key]; if (!a) return;
      status[key] = { state, bubble };
      a.bubbleEl.textContent = bubble || '';
      a.bubbleEl.classList.toggle('show', !!bubble);
      a.bubbleEl.classList.toggle('waiting', state === 'waiting');
      a.plateEl.classList.toggle('working', state === 'working');
    },
  };
})();
