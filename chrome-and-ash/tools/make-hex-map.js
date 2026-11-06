/* Генератор карты мозаичной трассы «Пыльная подкова».
   Запуск: node tools/make-hex-map.js
   Результат: docs/hex-track.svg */
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'track.js'));
const CnA = globalThis.CnA;

const track = CnA.buildMosaicTrack();
const nodes = track.nodes;
const T = CnA.TILES;
const size = track.size || 38;
const apothem = Math.sqrt(3) / 2 * size;

const COL = {
  bg: '#0f171c',
  dust: '#e0b060',
  dustDim: '#9b7436',
  sky: '#3ba7b0',
  rust: '#8c3a1e',
  chrome: '#d8d8d2',
  blood: '#c1272d',
  fire: '#f07a1e',
  neon: '#b8ff3c',
  ink: '#0b0f12',
  muted: '#9a9184',
  roadBorder: '#100e0c',
  asphalt: '#4d463b',
  line: 'rgba(233,226,214,.45)',
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function hexPoints(cx, cy, r) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 180 * (60 * k - 30);
    pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
  }
  return pts.join(' ');
}
function edgePoint(n, other) {
  const ang = Math.atan2(other.y - n.y, other.x - n.x);
  return { x: n.x + Math.cos(ang) * apothem, y: n.y + Math.sin(ang) * apothem };
}
function road(n, prev, next, pit) {
  const a = edgePoint(n, prev);
  const b = edgePoint(n, next);
  const w = size * 0.66;
  const w2 = size * 0.5;
  const center = pit ? COL.sky : COL.line;
  return `<path d="M ${a.x} ${a.y} Q ${n.x} ${n.y} ${b.x} ${b.y}" fill="none" stroke="${COL.roadBorder}" stroke-width="${w}" stroke-linecap="round"/>` +
    `<path d="M ${a.x} ${a.y} Q ${n.x} ${n.y} ${b.x} ${b.y}" fill="none" stroke="${COL.asphalt}" stroke-width="${w2}" stroke-linecap="round"/>` +
    `<path d="M ${a.x} ${a.y} Q ${n.x} ${n.y} ${b.x} ${b.y}" fill="none" stroke="${center}" stroke-width="1.6" stroke-dasharray="5 7" stroke-linecap="round"/>`;
}
function spur(n, other) {
  const b = edgePoint(n, other);
  return `<path d="M ${n.x} ${n.y} L ${b.x} ${b.y}" fill="none" stroke="${COL.sky}" stroke-width="${size * 0.24}" stroke-dasharray="6 6" stroke-linecap="round" opacity=".85"/>`;
}
function terrain(n) {
  const x = n.x, y = n.y;
  if (n.type === 'sand') {
    return '<g opacity=".9">' +
      '<path d="M ' + (x - 22) + ' ' + (y + 12) + ' q 7 -7 14 0 q 7 7 14 0" fill="none" stroke="#8a6c3c" stroke-width="1.8"/>' +
      '<path d="M ' + (x - 16) + ' ' + (y + 18) + ' q 7 -7 14 0 q 7 7 14 0" fill="none" stroke="#8a6c3c" stroke-width="1.4" opacity=".7"/>' +
      '<circle cx="' + (x - 24) + '" cy="' + (y - 16) + '" r="1.2" fill="#8a6c3c"/><circle cx="' + (x + 24) + '" cy="' + (y - 14) + '" r="1" fill="#8a6c3c"/>' +
      '</g>';
  }
  if (n.type === 'debris') {
    return '<g stroke="#4a3426" stroke-width="2" opacity=".9">' +
      '<line x1="' + (x - 22) + '" y1="' + (y - 14) + '" x2="' + (x - 10) + '" y2="' + (y - 2) + '"/>' +
      '<line x1="' + (x - 22) + '" y1="' + (y - 2) + '" x2="' + (x - 10) + '" y2="' + (y - 14) + '"/>' +
      '<line x1="' + (x + 12) + '" y1="' + (y + 10) + '" x2="' + (x + 24) + '" y2="' + (y + 22) + '"/>' +
      '<line x1="' + (x + 24) + '" y1="' + (y + 10) + '" x2="' + (x + 12) + '" y2="' + (y + 22) + '"/>' +
      '</g>';
  }
  if (n.type === 'event') {
    return '<text x="' + x + '" y="' + (y - 16) + '" text-anchor="middle" font-family="Arial Black, Impact" font-size="22" fill="#ffe2a8" opacity=".9">?</text>';
  }
  if (n.type === 'bridge') {
    return '<path d="M ' + (x - 32) + ' ' + (y + 16) + ' q 8 -12 16 0 q 8 12 16 0 q 8 -12 16 0" fill="none" stroke="#2a6a70" stroke-width="7" opacity=".45"/>';
  }
  if (n.type === 'tunnel') {
    return '<g opacity=".85"><path d="M ' + (x - 14) + ' ' + (y - 22) + ' q 14 -16 28 0" fill="none" stroke="#1b1917" stroke-width="6"/><path d="M ' + (x - 14) + ' ' + (y + 22) + ' q 14 16 28 0" fill="none" stroke="#1b1917" stroke-width="6"/></g>';
  }
  if (n.type === 'ramp') {
    return '<g stroke="#5a4526" stroke-width="2" opacity=".8"><path d="M ' + (x - 14) + ' ' + (y + 8) + ' l 7 -7 l 7 7" fill="none"/><path d="M ' + (x - 14) + ' ' + (y + 16) + ' l 7 -7 l 7 7" fill="none"/></g>';
  }
  return '';
}
function buildingArt(n) {
  const x = n.x, y = n.y;
  if (n.type === 'ruin') {
    return '<g opacity=".9" stroke="#2a1c12" stroke-width="1.5" fill="#6b5542">' +
      '<path d="M ' + (x - 18) + ' ' + (y + 12) + ' L ' + (x - 18) + ' ' + (y - 8) + ' L ' + (x - 5) + ' ' + (y - 8) + ' L ' + (x - 5) + ' ' + (y - 1) + ' L ' + (x + 7) + ' ' + (y - 1) + ' L ' + (x + 7) + ' ' + (y - 13) + ' L ' + (x + 18) + ' ' + (y - 13) + ' L ' + (x + 18) + ' ' + (y + 12) + ' Z"/>' +
      '<line x1="' + (x - 12) + '" y1="' + (y - 8) + '" x2="' + (x - 12) + '" y2="' + (y + 8) + '" stroke="#3a2a1c"/>' +
      '<line x1="' + (x + 12) + '" y1="' + (y - 13) + '" x2="' + (x + 12) + '" y2="' + (y + 4) + '" stroke="#3a2a1c"/>' +
      '</g>';
  }
  return '<g opacity=".95">' +
    '<rect x="' + (x - 16) + '" y="' + (y - 8) + '" width="32" height="20" fill="#6b4a32" stroke="#2a1c12" stroke-width="1.5"/>' +
    '<polygon points="' + (x - 20) + ',' + (y - 8) + ' ' + x + ',' + (y - 24) + ' ' + (x + 20) + ',' + (y - 8) + '" fill="#8c3a1e" stroke="#2a1c12" stroke-width="1.5"/>' +
    '<rect x="' + (x - 9) + '" y="' + (y + 1) + '" width="5" height="7" fill="#e0b060" opacity=".55"/>' +
    '<rect x="' + (x + 3) + '" y="' + (y + 1) + '" width="5" height="7" fill="#e0b060" opacity=".35"/>' +
    '<rect x="' + (x + 8) + '" y="' + (y - 21) + '" width="3" height="8" fill="#3a2a1c"/>' +
    '</g>';
}
function chevron(x, y, ang, color) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const p = (dx, dy) => `${x + dx * c - dy * s},${y + dx * s + dy * c}`;
  return `<polygon points="${p(-7, -5)} ${p(2, 0)} ${p(-7, 5)}" fill="${color}" opacity=".55"/>`;
}

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1120" viewBox="0 0 1400 1000">`);
parts.push(`<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#17262d"/>
    <stop offset=".6" stop-color="${COL.bg}"/>
    <stop offset="1" stop-color="#080c0f"/>
  </linearGradient>
  <radialGradient id="sun" cx=".5" cy=".5" r=".5">
    <stop offset="0" stop-color="#ffe4a8" stop-opacity=".85"/>
    <stop offset=".5" stop-color="${COL.dust}" stop-opacity=".35"/>
    <stop offset="1" stop-color="${COL.dust}" stop-opacity="0"/>
  </radialGradient>
  <pattern id="checker" width="10" height="10" patternUnits="userSpaceOnUse">
    <rect width="5" height="5" fill="#151515"/>
    <rect x="5" y="5" width="5" height="5" fill="#151515"/>
    <rect x="5" width="5" height="5" fill="${COL.chrome}"/>
    <rect y="5" width="5" height="5" fill="${COL.chrome}"/>
  </pattern>
  <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="8" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <style>
    .title { font-family: 'Arial Black', Impact, sans-serif; letter-spacing: .02em; }
    .h { font-family: 'Arial Black', Impact, sans-serif; letter-spacing: .06em; }
    .b { font-family: 'Segoe UI', Arial, sans-serif; }
    .m { font-family: 'Cascadia Mono', Consolas, monospace; }
    .lbl { font-family: 'Arial Black', Impact, sans-serif; font-size: 9px; letter-spacing: .06em; paint-order: stroke; stroke: rgba(0,0,0,.5); stroke-width: 2px; }
    .small { font-family: 'Segoe UI', Arial, sans-serif; font-size: 9px; fill: ${COL.muted}; }
  </style>
</defs>`);
parts.push(`<rect width="1400" height="1000" fill="url(#bg)"/>`);
parts.push(`<circle cx="1120" cy="160" r="240" fill="url(#sun)"/>`);
parts.push(`<g opacity=".18">`);
for (let i = 0; i < 16; i++) {
  parts.push(`<line x1="0" y1="${i * 70}" x2="1400" y2="${i * 70}" stroke="${COL.dust}" stroke-width=".5" opacity=".15"/>`);
}
parts.push(`</g>`);

// Заголовок
parts.push(`<g transform="translate(56,56)">`);
parts.push(`<text class="title" x="0" y="42" font-size="54" fill="${COL.dust}">ПЫЛЬНАЯ ПОДКОВА</text>`);
parts.push(`<text class="h" x="0" y="70" font-size="13" fill="${COL.chrome}">ЗАМКНУТАЯ ТРАССА ИЗ 36 ГЕКСОВ + 3 ПИТ-ТАЙЛА</text>`);
parts.push(`<text class="b" x="0" y="92" font-size="12" fill="${COL.muted}">Не кольцо: последовательность шиканы, правого спуска, шпильки и левого подъёма. Один круг — 36 шагов.</text>`);
parts.push(`</g>`);

// Легенда сверху справа
parts.push(`<g transform="translate(1030,58)">`);
parts.push(`<rect x="0" y="0" width="314" height="132" fill="rgba(10,14,17,.6)" stroke="rgba(224,176,96,.25)"/>`);
parts.push(`<text class="h" x="14" y="22" font-size="10" fill="${COL.dust}">СОСТАВ</text>`);
const stats = [
  ['36', 'тайлов в круге'],
  ['3', 'тайла пит-лейна'],
  ['10', 'тайлов застройки'],
  ['4', 'тайла стартовой решётки'],
];
stats.forEach(([v, k], i) => {
  const x = 14 + (i % 2) * 150;
  const y = 44 + Math.floor(i / 2) * 40;
  parts.push(`<text class="title" x="${x}" y="${y + 12}" font-size="22" fill="${COL.chrome}">${v}</text>`);
  parts.push(`<text class="small" x="${x}" y="${y + 26}">${k}</text>`);
});
parts.push(`</g>`);

// Группа трассы
parts.push(`<g transform="translate(150,120) scale(1.08)">`);
const all = nodes;
all.forEach((n) => {
  const tile = T[n.type] || T.straight;
  const isRoad = n.road !== false;
  const isHaz = CnA.HAZARD_TILES.includes(n.type);
  parts.push(`<g>`);
  parts.push(`<title>${esc(tile.label)} · тайл ${n.id}${n.pitLane ? ' · пит' : ''}</title>`);
  parts.push(`<polygon points="${hexPoints(n.x, n.y, size)}" fill="${tile.fill}" stroke="${isHaz ? 'rgba(193,39,45,.75)' : n.checkpoint ? 'rgba(59,167,176,.8)' : 'rgba(0,0,0,.55)'}" stroke-width="${isHaz || n.checkpoint ? 2.4 : 1.4}"/>`);
  if (!isRoad) parts.push(buildingArt(n));
  parts.push(terrain(n));
  if (isRoad && n.prev.length && n.next.length) {
    parts.push(road(n, nodes[n.prev[0]], nodes[n.next[0]], !!n.pitLane));
    n.next.slice(1).forEach((id) => parts.push(spur(n, nodes[id])));
    n.prev.slice(1).forEach((id) => parts.push(spur(n, nodes[id])));
  }
  parts.push(`</g>`);
});

// Дорожная разметка/указатели направления
track.main.forEach((id, i) => {
  if (i % 4 !== 0) return;
  const n = nodes[id];
  if (!n.next.length) return;
  const nn = nodes[n.next[0]];
  const ang = Math.atan2(nn.y - n.y, nn.x - n.x);
  parts.push(chevron(n.x, n.y, ang, COL.dust));
});

// Старт-финиш
const start = nodes[0];
parts.push(`<g transform="translate(${start.x},${start.y})">`);
parts.push(`<rect x="-28" y="-8" width="56" height="16" fill="url(#checker)" opacity=".95" transform="rotate(0)"/>`);
parts.push(`<rect x="-28" y="-8" width="56" height="16" fill="none" stroke="#fff" stroke-width="1" opacity=".5"/>`);
parts.push(`<text class="lbl" x="0" y="-40" text-anchor="middle" fill="${COL.dust}">СТАРТ / ФИНИШ</text>`);
parts.push(`<text class="small" x="0" y="-28" text-anchor="middle">решётка позади</text>`);
parts.push(`</g>`);

// Стартовая решётка: четыре машины позади линии
track.grid.forEach((id, i) => {
  const n = nodes[id];
  parts.push(`<g transform="translate(${n.x},${n.y})">`);
  parts.push(`<rect x="-4" y="-8" width="8" height="16" rx="2" fill="${COL.chrome}" stroke="#0b0f12" stroke-width="1.2"/>`);
  parts.push(`<text x="0" y="2" text-anchor="middle" font-family="Cascadia Mono, Consolas" font-size="7" fill="#0b0f12">${i + 1}</text>`);
  parts.push(`</g>`);
});

// Пит-лейн: боксы
track.pit.forEach((id, i) => {
  const n = nodes[id];
  parts.push(`<g transform="translate(${n.x},${n.y})">`);
  parts.push(`<rect x="-20" y="24" width="12" height="16" fill="#173f43" stroke="${COL.sky}" stroke-width="1"/>`);
  parts.push(`<rect x="-4" y="24" width="12" height="16" fill="#173f43" stroke="${COL.sky}" stroke-width="1"/>`);
  parts.push(`<rect x="12" y="24" width="12" height="16" fill="#173f43" stroke="${COL.sky}" stroke-width="1"/>`);
  parts.push(`<text class="m" x="0" y="50" text-anchor="middle" font-size="8" fill="${COL.sky}">P${i + 1}</text>`);
  parts.push(`</g>`);
});
parts.push(`<text class="lbl" x="${nodes[track.pit[1]].x - 96}" y="${nodes[track.pit[1]].y - 36}" text-anchor="middle" fill="${COL.sky}">ПИТ-ЛЕЙН</text>`);

// КП
const cp = nodes[track.checkpoints[1]];
parts.push(`<g transform="translate(${cp.x},${cp.y})">`);
parts.push(`<line x1="0" y1="-4" x2="0" y2="-28" stroke="${COL.chrome}" stroke-width="2"/>`);
parts.push(`<polygon points="0,-28 18,-23 0,-18" fill="${COL.sky}"/>`);
parts.push(`<text class="lbl" x="0" y="30" text-anchor="middle" fill="${COL.sky}">КП</text>`);
parts.push(`</g>`);

// Подписи участков
function tag(x, y, text, color, rot) {
  return `<g transform="translate(${x},${y}) rotate(${rot || 0})"><rect x="-46" y="-12" width="92" height="20" rx="2" fill="rgba(10,14,17,.78)" stroke="${color}" stroke-opacity=".5"/><text class="lbl" x="0" y="3" text-anchor="middle" fill="${color}">${text}</text></g>`;
}
parts.push(tag(790, 290, 'ШИКАНА', COL.fire, -4));
parts.push(tag(500, 610, 'ШПИЛЬКА', COL.blood, -8));
parts.push(tag(760, 500, 'МОСТ', COL.sky, 0));
parts.push(tag(1020, 300, 'ТОННЕЛЬ', COL.chrome, 0));
parts.push(tag(250, 470, 'ГОРОДСКИЕ РУИНЫ', COL.dustDim, 0));
parts.push('</g>');

// Легенда
const lx = 56, ly = 790;
parts.push(`<g transform="translate(${lx},${ly})">`);
parts.push(`<text class="h" x="0" y="0" font-size="11" fill="${COL.dust}">ЛЕГЕНДА</text>`);
const items = [
  ['#4d463b', 'дорога'],
  [COL.sky, 'пит-лейн'],
  ['#e8e2d2', 'старт-финиш'],
  [COL.sky, 'контрольный пункт'],
  ['#c9a15e', 'песок'],
  ['#7a5a44', 'обломки'],
  ['#8c5a2a', 'пустошь ?'],
  ['#4a4038', 'мост'],
  ['#34302c', 'тоннель'],
  ['#4b3a2e', 'здание'],
  ['#5a4c3e', 'руины'],
];
items.forEach(([c, label], i) => {
  const x = (i % 6) * 190;
  const y = 24 + Math.floor(i / 6) * 26;
  parts.push(`<rect x="${x}" y="${y}" width="14" height="14" fill="${c}" stroke="rgba(255,255,255,.15)"/>`);
  parts.push(`<text class="b" x="${x + 20}" y="${y + 11}" font-size="11" fill="${COL.chrome}">${label}</text>`);
});
parts.push(`<text class="small" x="0" y="82">39 дорожных тайлов; 10 тайлов застройки — отдельный набор/оверлеи. Сборка: дорожные выходы на гранях, развилка только в пит-лейне.</text>`);
parts.push(`</g>`);

// Футер
parts.push(`<g transform="translate(56,940)">`);
parts.push(`<text class="small" x="0" y="0">ХРОМ И ПЕПЕЛ · цифровой прототип · вариант трассы для мозаичной сборки</text>`);
parts.push(`<text class="m" x="0" y="18" font-size="9" fill="rgba(154,145,132,.6)">36 + 3 тайла · стартовая решётка 4 тайла · один круг = 36 шагов + пит-ветка</text>`);
parts.push(`</g>`);

parts.push(`</svg>`);

fs.writeFileSync(path.join(__dirname, '..', 'docs', 'hex-track.svg'), parts.join('\n'), 'utf8');
console.log('written docs/hex-track.svg');
