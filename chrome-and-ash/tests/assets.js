/* Проверка точки подключения ассетов: manifest.json и js/assets.js согласованы
   друг с другом и покрывают все данные игры (data.js). Никакого арта не генерирует. */
const path = require('path');
const fs = require('fs');

require(path.join(__dirname, '..', 'js', 'data.js'));
require(path.join(__dirname, '..', 'js', 'assets.js'));
const CnA = globalThis.CnA;

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'manifest.json'), 'utf8'));

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log('  \u2713 ' + msg);
  else { console.error('  \u2717 ' + msg); failures++; }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  ok(sa === sb, msg + (sa === sb ? '' : '  (получено ' + sa + ', ожидалось ' + sb + ')'));
}

console.log('== assets: соглашение о путях ==');

// 1. Манифест
ok(!!manifest && manifest.version === 1, 'manifest.json: version = 1');
ok(manifest.base === 'assets/', 'manifest.json: base = assets/');

// 2. Каталог совпадает между manifest.json и js/assets.js
['tile', 'card', 'upgrade', 'event', 'faction', 'token', 'bg', 'dice'].forEach((kind) => {
  const a = (CnA.assets.CATALOG[kind] || []).slice().sort();
  const b = (manifest.catalog[kind] || []).slice().sort();
  eq(a, b, 'каталог "' + kind + '" совпадает manifest \u2194 assets.js');
});

// 3. Каталог покрывает данные data.js (ни один компонент не остался без слота)
eq(Object.keys(CnA.TILES).slice().sort(), CnA.assets.CATALOG.tile.slice().sort(), 'tiles покрывают CnA.TILES');
eq(Object.keys(CnA.CARDS).slice().sort(), CnA.assets.CATALOG.card.slice().sort(), 'cards покрывают CnA.CARDS');
eq(CnA.UPGRADES.map((u) => u.id).slice().sort(), CnA.assets.CATALOG.upgrade.slice().sort(), 'upgrade покрывают CnA.UPGRADES');
eq(CnA.EVENTS.map((e) => e.id).slice().sort(), CnA.assets.CATALOG.event.slice().sort(), 'event покрывают CnA.EVENTS');
eq(CnA.FACTIONS.map((f) => f.id).slice().sort(), CnA.assets.CATALOG.faction.slice().sort(), 'faction покрывают CnA.FACTIONS');

// 4. Разрешение путей
const sample = { tile: 'start', card: 'mg', upgrade: 'engine2', event: 'sandstorm', token: 'mine', bg: 'menu-sunset', dice: 'd4' };
Object.keys(sample).forEach((kind) => {
  const id = sample[kind];
  const p = CnA.assets.resolve(kind, id);
  const expected = 'assets/' + manifest.kinds[kind].dir + '/' + id + '.png';
  ok(p === expected, kind + ': resolve \u2192 ' + p);
});
ok(CnA.assets.resolve('faction', 'rust', 'standee') === 'assets/factions/rust/standee.png', 'faction: resolve(standee)');
ok(CnA.assets.resolve('faction', 'rust') === 'assets/factions/rust/standee.png', 'faction: часть по умолчанию standee');
ok(CnA.assets.resolve('nope', 'x') === null, 'неизвестный kind \u2192 null');

// 5. Все слагы валидны: kebab-case ASCII, без кириллицы/пробелов/заглавных
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
['tile', 'card', 'upgrade', 'event', 'faction', 'token', 'bg', 'dice'].forEach((kind) => {
  (CnA.assets.CATALOG[kind] || []).forEach((id) => ok(SLUG.test(id), 'slug ' + kind + ':' + id + ' валиден'));
});

// 6. Достаточность жетонов: 4 бортовых + статусы + лом
['mine', 'oil', 'fire', 'wreck', 'scrap'].forEach((id) => {
  ok((CnA.assets.CATALOG.token || []).indexOf(id) >= 0, 'жетон "' + id + '" есть в каталоге');
});

console.log('');
if (failures) { console.error('ASSETS: FAIL \u2014 ' + failures + ' проверка(и) не пройдена'); process.exit(1); }
console.log('ASSETS: OK \u2014 соглашение о путях корректно и покрывает все данные игры');
