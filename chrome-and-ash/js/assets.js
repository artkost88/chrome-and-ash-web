/* ХРОМ И ПЕПЕЛ — точка подключения ассетов (ЗАГЛУШКА).
 *
 * Арта пока нет. Этот файл фиксирует СОГЛАШЕНИЕ о путях и именах и даёт единую
 * точку, через которую интерфейс будет подхватывать сгенерированные фоны/карты/тайлы.
 * Рендер ui.js по-прежнему рисует всё SVG/CSS; вызовы CnA.assets.* появятся на
 * следующем шаге вместе с арт-плагином Yandex ART.
 *
 * Рантайм-источник имён — этот файл; инструментальный (Node) — assets/manifest.json.
 * Они должны совпадать: расхождение ловит tests/assets.js.
 * Полный текст — docs/06-asset-pipeline.md.
 */
(function (root) {
  'use strict';
  const CnA = (root.CnA = root.CnA || {});

  const BASE = 'assets/';
  const EXT = '.png';

  // kind -> директория и правило имени файла. Синхронно с assets/manifest.json.
  const KINDS = {
    bg:      { dir: 'bg',             name: (id) => id + EXT },
    tile:    { dir: 'tiles',          name: (id) => id + EXT },
    card:    { dir: 'cards/arsenal',  name: (id) => id + EXT },
    upgrade: { dir: 'cards/upgrade',  name: (id) => id + EXT },
    event:   { dir: 'cards/event',    name: (id) => id + EXT },
    token:   { dir: 'tokens',         name: (id) => id + EXT },
    dice:    { dir: 'dice',           name: (id) => id + EXT },
    faction: { dir: 'factions',       name: (id, part) => id + '/' + (part || 'standee') + EXT },
  };

  // Каталог ожидаемых ключей. Зеркало данных data.js (проверяется в tests/assets.js)
  // и одновременно список «что генерировать» для арт-плагина.
  const CATALOG = {
    tile:    ['start', 'straight', 'turn', 'fork', 'sand', 'debris', 'ramp', 'tunnel', 'bridge', 'event', 'pit', 'checkpoint', 'building', 'ruin'],
    card:    ['mg', 'twin', 'rocket', 'harpoon', 'mine', 'oil', 'flamer', 'smoke', 'nitro', 'brake', 'ramplate', 'repair', 'jammer', 'canister', 'drone', 'boost', 'ramboost', 'shield', 'emp', 'net', 'sabotage', 'tow'],
    upgrade: ['engine2', 'engine3', 'turbo', 'armor', 'reactive', 'plow', 'suspension', 'tracks', 'balance', 'turret', 'barrel', 'autoloader', 'spikes', 'cage', 'magnet'],
    event:   ['sandstorm', 'scavengers', 'depot', 'spill', 'asphalt', 'sinkhole', 'witnesses', 'night', 'fuel'],
    faction: ['chrome', 'rust', 'carnival', 'swarm'],
    factionParts: ['standee', 'glyph', 'silhouette', 'portrait'],
    token:   ['mine', 'oil', 'fire', 'wreck', 'shield', 'smoke', 'burn', 'emp', 'scrap'],
    bg:      ['menu-sunset', 'board-desert', 'board-night', 'card-back'],
    dice:    ['d4'],
  };

  function slug(id) { return String(id == null ? '' : id); }

  // Возвращает путь относительно корня проекта или null, если kind неизвестен.
  // Файл может ещё не существовать: это конвенция, а не проверка наличия на диске.
  function resolve(kind, id, part) {
    const spec = KINDS[kind];
    if (!spec) return null;
    return BASE + spec.dir + '/' + spec.name(slug(id), part == null ? undefined : slug(part));
  }

  function url(kind, id, part) { return resolve(kind, id, part); }

  // Есть ли ключ в каталоге (НЕ «существует ли файл на диске»).
  function has(kind, id) {
    const list = CATALOG[kind];
    return !!list && list.indexOf(slug(id)) >= 0;
  }

  CnA.assets = { BASE, EXT, KINDS, CATALOG, resolve, url, has };
})(typeof globalThis !== 'undefined' ? globalThis : window);
