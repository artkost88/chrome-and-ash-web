/* Генератор схемы «грамматика гекса»: docs/hex-tiles.svg */
const fs = require('fs');
const path = require('path');

const C = {
  bg: '#0f171c', dust: '#e0b060', chrome: '#d8d8d2', muted: '#9a9184',
  sky: '#3ba7b0', rust: '#8c3a1e', fire: '#f07a1e', ink: '#0b0f12',
  line: 'rgba(233,226,214,.5)', road: '#4d463b', border: '#141210',
};
const S = Math.sqrt(3) / 2;

function hex(cx, cy, r, fill, stroke, sw) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 180 * (60 * k - 30);
    pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${stroke || 'rgba(0,0,0,.5)'}" stroke-width="${sw || 1.5}"/>`;
}
function edge(cx, cy, r, dir) {
  const angles = { E: 0, NE: -60, NW: -120, W: 180, SW: 120, SE: 60 };
  const a = angles[dir] * Math.PI / 180;
  const ap = S * r;
  return { x: cx + Math.cos(a) * ap, y: cy + Math.sin(a) * ap };
}
function road(cx, cy, r, a, b, color) {
  const p = edge(cx, cy, r, a);
  const q = edge(cx, cy, r, b);
  return `<path d="M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}" fill="none" stroke="${C.border}" stroke-width="${r * 0.3}" stroke-linecap="round"/>` +
    `<path d="M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}" fill="none" stroke="${C.road}" stroke-width="${r * 0.21}" stroke-linecap="round"/>` +
    `<path d="M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}" fill="none" stroke="${color || C.line}" stroke-width="1.2" stroke-dasharray="3 5" stroke-linecap="round"/>`;
}
function label(cx, cy, text, color, size) {
  return `<text x="${cx}" y="${cy}" text-anchor="middle" font-family="Arial Black, Impact, sans-serif" font-size="${size || 10}" fill="${color || C.chrome}" letter-spacing=".04em">${text}</text>`;
}
function smallTile(cx, cy, r, kind) {
  let s = hex(cx, cy, r, '#6f665a');
  const bottom = cy + r * 0.95;
  if (kind === 'straight') {
    s += road(cx, cy, r, 'W', 'E');
  } else if (kind === 'turn60') {
    s += road(cx, cy, r, 'W', 'NE');
  } else if (kind === 'turn120') {
    s += road(cx, cy, r, 'W', 'SE');
  } else if (kind === 'y') {
    s += road(cx, cy, r, 'W', 'E');
    const p = edge(cx, cy, r, 'SE');
    s += `<line x1="${cx}" y1="${cy}" x2="${p.x}" y2="${p.y}" stroke="${C.sky}" stroke-width="${r * 0.22}" stroke-dasharray="5 5"/>`;
  } else if (kind === 'start') {
    s += road(cx, cy, r, 'W', 'E');
    s += `<rect x="${cx - 20}" y="${cy - 5}" width="40" height="10" fill="url(#checker)"/>`;
  } else if (kind === 'kp') {
    s += road(cx, cy, r, 'W', 'E');
    s += `<line x1="${cx}" y1="${cy - 6}" x2="${cx}" y2="${cy - 28}" stroke="${C.chrome}" stroke-width="2"/>`;
    s += `<polygon points="${cx},${cy - 28} ${cx + 16},${cy - 24} ${cx},${cy - 20}" fill="${C.sky}"/>`;
  } else if (kind === 'sand') {
    s += road(cx, cy, r, 'W', 'E');
    s += `<path d="M ${cx - 30} ${cy + 28} q 8 -8 16 0 q 8 8 16 0" fill="none" stroke="#8a6c3c" stroke-width="2"/>`;
    s += `<path d="M ${cx - 22} ${cy + 34} q 8 -8 16 0" fill="none" stroke="#8a6c3c" stroke-width="1.4"/>`;
  } else if (kind === 'debris') {
    s += road(cx, cy, r, 'W', 'E');
    s += `<g stroke="#4a3426" stroke-width="2.5"><line x1="${cx - 30}" y1="${cy + 22}" x2="${cx - 18}" y2="${cy + 34}"/><line x1="${cx - 18}" y1="${cy + 22}" x2="${cx - 30}" y2="${cy + 34}"/></g>`;
  } else if (kind === 'ramp') {
    s += road(cx, cy, r, 'W', 'E');
    s += `<path d="M ${cx - 20} ${cy + 24} l 10 -10 l 10 10" fill="none" stroke="#5a4526" stroke-width="2"/><path d="M ${cx - 20} ${cy + 34} l 10 -10 l 10 10" fill="none" stroke="#5a4526" stroke-width="2"/>`;
  } else if (kind === 'bridge') {
    s += `<path d="M ${cx - 44} ${cy + 24} q 10 -14 20 0 q 10 14 20 0 q 10 -14 20 0" fill="none" stroke="#2a6a70" stroke-width="7" opacity=".5"/>`;
    s += road(cx, cy, r, 'W', 'E');
  } else if (kind === 'tunnel') {
    s += road(cx, cy, r, 'W', 'E');
    s += `<path d="M ${cx - 24} ${cy - 24} q 24 -18 48 0" fill="none" stroke="#1b1917" stroke-width="7"/><path d="M ${cx - 24} ${cy + 24} q 24 18 48 0" fill="none" stroke="#1b1917" stroke-width="7"/>`;
  } else if (kind === 'building') {
    s = hex(cx, cy, r, '#4b3a2e');
    s += `<rect x="${cx - 18}" y="${cy - 6}" width="36" height="22" fill="#6b4a32" stroke="#2a1c12"/>`;
    s += `<polygon points="${cx - 22},${cy - 6} ${cx},${cy - 24} ${cx + 22},${cy - 6}" fill="${C.rust}" stroke="#2a1c12"/>`;
    s += `<rect x="${cx - 9}" y="${cy + 2}" width="5" height="7" fill="${C.dust}" opacity=".55"/>`;
  }
  return s + label(cx, bottom + 16, {
    straight: 'ПРЯМАЯ', turn60: 'МЯГКИЙ 60°', turn120: 'КРУТОЙ 120°',
    y: 'РАЗВИЛКА', start: 'СТАРТ', kp: 'КП', sand: 'ПЕСОК',
    debris: 'ОБЛОМКИ', ramp: 'ТРАМПЛИН', bridge: 'МОСТ',
    tunnel: 'ТОННЕЛЬ', building: 'ЗДАНИЕ',
  }[kind], C.muted, 9);
}

const svg = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="900" viewBox="0 0 1500 900">`);
svg.push(`<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17262d"/><stop offset="1" stop-color="${C.bg}"/></linearGradient>
  <pattern id="checker" width="10" height="10" patternUnits="userSpaceOnUse">
    <rect width="5" height="5" fill="#151515"/><rect x="5" y="5" width="5" height="5" fill="#151515"/>
    <rect x="5" width="5" height="5" fill="${C.chrome}"/><rect y="5" width="5" height="5" fill="${C.chrome}"/>
  </pattern>
  <style>.h{font-family:'Arial Black',Impact,sans-serif;letter-spacing:.05em}.b{font-family:'Segoe UI',Arial,sans-serif}.m{font-family:'Cascadia Mono',Consolas,monospace}</style>
</defs>`);
svg.push(`<rect width="1500" height="900" fill="url(#bg)"/>`);
svg.push(`<text class="h" x="56" y="70" font-size="38" fill="${C.dust}">ГРАММАТИКА ГЕКСА</text>`);
svg.push(`<text class="b" x="56" y="98" font-size="14" fill="${C.muted}">Трасса — не кольцо, а цикл по портам. Один гекс = один тайл; дорога занимает два порта, поворот меняет направление на 60° или 120°.</text>`);

// Большой гекс
const cx = 300, cy = 410, r = 150;
svg.push(hex(cx, cy, r, '#6f665a', 'rgba(224,176,96,.45)', 3));
svg.push(road(cx, cy, r, 'W', 'E'));
// здание и песок на плечах
svg.push(`<g transform="translate(${cx},${cy - 92})"><rect x="-38" y="-6" width="76" height="34" fill="#6b4a32" stroke="#2a1c12"/><polygon points="-44,-6 0,-38 44,-6" fill="${C.rust}" stroke="#2a1c12"/><rect x="-20" y="4" width="9" height="12" fill="${C.dust}" opacity=".55"/><rect x="10" y="4" width="9" height="12" fill="${C.dust}" opacity=".35"/></g>`);
svg.push(`<path d="M ${cx - 80} ${cy + 94} q 20 -16 40 0 q 20 16 40 0 q 20 -16 40 0" fill="none" stroke="#8a6c3c" stroke-width="3" opacity=".8"/>`);
// порты
const ports = [['E', 0], ['NE', -60], ['NW', -120], ['W', 180], ['SW', 120], ['SE', 60]];
const names = ['A', 'B', 'C', 'D', 'E', 'F'];
ports.forEach(([dir, ang], i) => {
  const p = edge(cx, cy, r, dir);
  const L = edge(cx, cy, r + 34, dir);
  svg.push(`<line x1="${p.x}" y1="${p.y}" x2="${L.x}" y2="${L.y}" stroke="${C.dust}" stroke-width="1.5" stroke-dasharray="3 4"/>`);
  svg.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="${C.dust}"/>`);
  svg.push(label(L.x, L.y + 4, names[i], C.dust, 14));
});
svg.push(label(cx, cy + 220, 'ДОРОГА + ПЛЕЧИ', C.dust, 14));
svg.push(`<text class="b" x="${cx}" y="${cy + 242}" text-anchor="middle" font-size="12" fill="${C.muted}">дорога соединяет два порта; плечи заняты зданием, песком или обломками</text>`);

// Сетка малых тайлов
const kinds = ['straight', 'turn60', 'turn120', 'y', 'start', 'kp', 'sand', 'debris', 'ramp', 'bridge', 'tunnel', 'building'];
kinds.forEach((kind, i) => {
  const col = i % 6;
  const row = Math.floor(i / 6);
  const x = 600 + col * 145;
  const y = 250 + row * 270;
  svg.push(smallTile(x, y, 50, kind));
});

svg.push(`<text class="m" x="56" y="830" font-size="12" fill="rgba(154,145,132,.7)">36 тайлов в круге: 18 прямых, 12 мягких, 4 крутых, 2 развилки. + 3 пит-тайла + 10 застройки. Порты A–F; поворот тайла на 60°.</text>`);
svg.push(`<text class="b" x="56" y="856" font-size="11" fill="rgba(154,145,132,.55)">ХРОМ И ПЕПЕЛ · схема для сборки трассы «Пыльная подкова»</text>`);
svg.push(`</svg>`);

fs.writeFileSync(path.join(__dirname, '..', 'docs', 'hex-tiles.svg'), svg.join('\n'), 'utf8');
console.log('written docs/hex-tiles.svg');
