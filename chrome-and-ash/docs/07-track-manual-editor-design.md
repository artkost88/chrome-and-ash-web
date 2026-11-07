# Ручной редактор трасс (этап B): проектное решение

**Статус:** проект Stage B поверх параметрического конструктора v1. Код приложения не меняется этим документом.
**Контракт:** `TrackSpec` `schemaVersion: 1` и localStorage-конверт `cna.customTracks.v1` остаются неизменными; ручная правка компилируется в обычный `TrackSpec`, который проверяет `CnA.validateTrackSpec`, компилирует `CnA.compileTrack` и принимает `createGame({trackSpec})`.
**Проверено при проектировании:** после нормализации известного дефекта «подковы» строгий draft-валидатор принял 300 сгенерированных спек (100 сидов × 3 архетипа); несоседних рёбер — 0.
**Файлы Stage B:** `chrome-and-ash-web/js/track-editor.js` (чистая модель), `chrome-and-ash-web/js/track-editor-ui.js` (DOM), `chrome-and-ash-web/index.html`, `chrome-and-ash-web/style.css`, `chrome-and-ash-web/tests/track-editor.test.mjs`. `track-gen.js`/`engine.js`/`ui.js` не меняются.

---

## 1. Цели, нецели, сценарий

**Цели:** править сгенерированную трассу вручную на осевой гекс-сетке; каждая правка атомарна, отменяема и валидна; сохранять/экспортировать/тест-драйвить результат через существующие v1-пути; не ломать free race, daily, PvP и старые сохранения.

**Нецели:** серверная библиотека и share-ссылки (Stage C), `TrackSpec` v2, новые механики тайлов, путепроводы/многоуровневость, свободная геометрия вне сетки, редактор декора, совместное редактирование.

**Поток:** гараж → `#screen-constructor` → «СГЕНЕРИРОВАТЬ» (v1-параметры) → draft → выбор/кисть/вставка/сдвиг/объекты → авто-валидация каждой операции → «СОХРАНИТЬ»/«ЭКСПОРТ» → «ТЕСТ-ДРАЙВ» (`CnA.UI.startCustomTrack(current.spec)`). Возврат/загрузка/генерация/импорт при несохранённых правках спрашивают подтверждение; `beforeunload` ставится только при `dirty`.

---

## 2. Модель данных

```js
// CnA.TrackDraft, живёт в track-editor.js; НЕ путать с TrackSpec
{
  draftVersion: 1, name, hexSize, layout: 'axial',
  nodes: [{ uid: 'd7', q: 3, r: 1, type: 'turn' }], // decor-узлы тоже здесь
  main: ['d0','d1', ...],        // упорядоченный цикл, main[0] === startUid
  startUid: 'd0', checkpointUid: 'd12',
  grid: ['d34','d34','d35','d35'], // производное, только чтение в UI
  pit: null | { kind:'tile', tile:'d2' }
            | { kind:'branch', entry:'d33', exit:'d35', nodes:['d36','d37','d38'] },
  shortcut: null | { entry:'d11', exit:'d16', nodes:['d31'] },
  decor: ['d39', ...], legacyDecor: [], // объектный decor (docs/05) — passthrough
  locks: { nodes: { d7:{pos:true,type:true,remove:true} },
           features: { start:true, checkpoint:true, grid:true, pit:true, shortcut:true } },
  source: { kind:'generated'|'saved'|'imported', trackId:null, archetype:'horseshoe', seed:123,
            specId:'horseshoe-...', sourceSpec: {/*deep clone*/}, migrated:[] }
}
```

- **Стабильные UID.** Внутренние `d<seq>` уникальны на сессию (`session.uidSeq` не откатывается undo) и не попадают в `TrackSpec`. На них ссылаются selection, focus, locks, issues и снапшоты. Numeric id в спеке переназначаются только в `toSpec`; после любой операции `spec.nodes[i].id === i`.
- **Канонический порядок id:** main 0..M−1 → pit-ветка → shortcut-ветка → decor. Это ровно порядок `buildAxialSpec`/`buildHorseshoeSpec`; `canonicalizeSpec(spec)` перестраивает `nodes`, `main`, `grid`, `checkpoints`, `startNode`, `next/prev`, `pit`, `shortcut`, `decor` и отбрасывает висячие ссылки. Конверт/импорт/экспорт/превью всегда канонизируются; стабильные UID не утекают.
- **`main[0] === startUid`.** Перенос старта поворачивает цикл: `main = [old[i], …, old[i−1]]`; `grid` немедленно пересобирается как `[main[n−1], main[n−1], main[n−2], main[n−2]]` (2 тайла × 2 машины), старый старт становится `straight`, новый — `start`.
- **КП:** ровно один не-стартовый узел main с `type:'checkpoint'`, индекс 25–65 %; `checkpoints` всегда `[startUid, checkpointUid]`; старый КП становится `straight`.
- **Ветки:** `pit` — либо тайл на main, либо упорядоченная ветка entry→nodes→exit; `shortcut` — только ветка и обязан иметь ≥1 опасность. Одновременно допустим только один branch-объект (`pit.kind:'branch'` XOR `shortcut`); pit-тайл может сосуществовать со срезом.
- **Снапшоты:** `session.past/future`, до 50, `{draft:deepClone, selectionUid, focusUid, revision}`. Undo/redo восстанавливают draft, locks, выбор и focus; камера не откатывается, но `ensureVisible` доносит выбранный узел.
- **Dirty:** `fingerprint(specFromDraft(draft))` против `savedFingerprint`; имя входит, locks/выбор/камера — нет. Несохранённая сгенерированная трасса dirty (baseline `null`). Save/undo/redo/reset пересчитывают флаг автоматически.
- **XSS-граница:** импорт/localStorage недоверенны. `canonicalizeSpec` делает id числовыми, `cleanName` чистит имя, любой вывод в SVG/HTML идёт через `esc()` — включая `data-node` в `previewSvg` (сейчас `n.id` вставляется сырым, строка 134) и `data-uid/type/aria-label/title` в новом рендере. Никаких `innerHTML` с `spec.name/env.name`; списки и инспектор — `textContent`.

---

## 3. Операции редактирования

Единый контракт `CnA.TrackDraftSession.apply(op) → {ok, issues, selectionUid, requiresConfirm?}`:
1. preflight и построение **кандидата без мутации** исходника;
2. `toSpec(candidate)` → `validateDraft(candidate)` + `CnA.validateTrackSpec(spec)`;
3. любая `E_*` — операция отклонена целиком, исходник и history не меняются, `lastRejected` показывается в панели; `W_*` не блокируют;
4. успех — один снапшот в `past`, `future=[]`, выбор на затронутом узле. Кисть-протяжка — одна транзакция: падение любого шага откатывает всю протяжку.
`{force:true}` принимается только после подтверждения в UI (замена пита/среза, reset).

| Операция | Предусловия | Коды и сообщения отказа |
|---|---|---|
| `paint(uid,type)` | узел road; `type` из палитры; не start/checkpoint/pit (для них инструменты); не заблокирован `type`; shortcut сохраняет ≥1 опасность; hazard/ramp не на start/grid/CP; hazards ≤2 подряд с учётом замыкания; tunnel/bridge только main | `E_NO_NODE` «Тайл не найден.»; `E_LOCKED_TYPE` «Тип тайла заблокирован.»; `E_PAINT_FEATURE` «Старт, КП и пит меняются инструментами.»; `E_TILE_ROLE` «Этот тип доступен только основной петле.»; `E_SHORTCUT_RISK` «На срезе должна остаться хотя бы одна опасность.»; `E_HAZARD_RUN` «Нельзя ставить третью опасность подряд.»; `E_HAZARD_ZONE`/`E_RAMP_ZONE` «Опасность/трамплин нельзя ставить на старт, решётку или КП.» |
| `insertBetween(fromUid,toUid)` | между ними есть ребро main/ветки; main < 36; пит после вставки ≥2; срез сохраняет экономию 1–2; есть свободная общая соседняя клетка; нет дубля/пересечения; feature-lock не запрещает | `E_INSERT_EDGE` «Между этими тайлами нет ребра.»; `E_LENGTH_MAX` «Круг уже максимальной длины (36).»; `E_INSERT_NO_CELL` «Нет свободной соседней клетки для нового тайла.»; `E_DUPLICATE_COORD` «Клетка уже занята.»; `E_CROSSING` «Новая дорога пересекает существующую.»; `E_LOCKED_FEATURE` «Объект заблокирован.» |
| `remove(uid)` | не start/CP/grid/branch-entry/exit; main > 24; после удаления соседи **соседние по осям** (в гекс-сетке законно только на изломе 60°); степень 1/1; ветки сохраняют длину/экономию/риск | `E_REMOVE_FEATURE` «Старт, КП, решётка и концы веток не удаляются — используйте инструмент.»; `E_LENGTH_MIN` «Круг уже минимальной длины (24).»; `E_REMOVE_GEOMETRY` «После удаления соседние тайлы не соприкасаются — сначала сдвиньте соседа.»; `E_LOCKED_REMOVE` «Тайл защищён от удаления.» |
| `move(uid,q,r)` | узел не заблокирован `pos`; клетка свободна от road (декор вытесняется, `W_DECOR_CLEARED`); узел остаётся соседним **всем** соединённым соседям (prev+next, включая ветки); дубль/пересечение запрещены; правила start/CP/pit/shortcut перепроверяются | `E_MOVE_OCCUPIED` «Клетка занята тайлом #N.»; `E_MOVE_ADJACENCY` «Тайл должен остаться соседним со всеми соседями по дороге.»; `E_CROSSING`; `E_LOCKED_POS` «Позиция тайла закреплена.» |
| `setStart(uid)` | main, не branch/декор; не hazard/ramp; не КП и не pit-тайл; не branch-entry/exit; новые grid-тайлы чистые; поворот не выводит КП из 25–65 % | `E_START_ROLE` «Старт ставится только на основную петлю.»; `E_START_CP` «Сначала снимите КП с этого тайла.»; `E_START_ZONE` «Рядом со стартом нельзя опасность, трамплин или конец ветки.»; `E_START_CP_RANGE` «КП выйдет из 25–65 %; сначала перенесите КП.»; `E_LOCKED_FEATURE` |
| `setCheckpoint(uid)` | main, не start/grid/branch-entry/exit; индекс 25–65 %; не hazard/ramp; feature-lock снят; старый КП гасится | `E_CHECKPOINT_ROLE` «КП ставится только на основную петлю.»; `E_CHECKPOINT_RANGE` «КП должен быть между 25 % и 65 % круга.»; `E_CHECKPOINT_ZONE` «Опасность/трамплин не может быть КП.»; `E_CHECKPOINT_GRID` «КП нельзя ставить на стартовую решётку.»; `E_LOCKED_FEATURE` |
| `setPitTile(uid)` | main, не start/CP/grid/branch-endpoint; заменяет старый пит после `E_CONFIRM_REQUIRED` | `E_PIT_ROLE`; `E_PIT_CONFLICT` «Сначала снимите старый пит.»; `E_LOCKED_FEATURE` |
| `setPitBranch(entry,exit)` | оба main, разные, не start/CP/grid/чужие концы; индексная дистанция 2–5; авто-маршрут ≥2 узлов и длиннее main-сегмента (пит — не срез); только main-клетки свободны; нет hazard | `E_PIT_DISTANCE` «Вход и выход пита должны быть на расстоянии 2–5 тайлов.»; `E_PIT_LENGTH` «Пит-ветка должна быть длиннее главной трассы.»; `E_PIT_NO_PATH` «Не удалось проложить пит-ветку: нет свободного коридора.»; `E_PIT_CONFLICT` «Срез и пит-ветка несовместимы.» |
| `setShortcut(entry,exit)` | оба main, разные, не start/CP/grid/чужие концы; индекс entry>3 и exit<len−3; экономия `(exit−entry+len)%len − (nodes+1)` = 1–2; ≥1 узел, ≥1 hazard (новая ветка получает `debris`); нет пит-ветки | `E_SHORTCUT_SAVING` «Срез должен экономить 1–2 тайла.»; `E_SHORTCUT_NEAR_START` «Срез нельзя ставить в первых/последних 3 тайлах.»; `E_SHORTCUT_RISK`; `E_SHORTCUT_NO_PATH`; `E_SHORTCUT_CONFLICT` «Срез и пит-ветка несовместимы.» |
| `clearPit()` / `clearShortcut()` | feature-lock снят | `E_LOCKED_FEATURE`; узлы ветки удаляются, pit-тайл → `straight` |
| `setLock(uid,flags)` | всегда; undo-шаг, но не dirty и не экспортируется | — |
| `undo()` / `redo()` | стек не пуст | `E_UNDO_EMPTY` «Нечего отменять.»; `E_REDO_EMPTY` «Нечего повторять.» |
| `reset()` | подтверждение; возвращает draft из `source.sourceSpec` (сгенерированный) или baseline сохранённой трассы, чистит history | — |

**Кисть и сдвиг.** Протяжка мышью красит все узлы под курсором одной транзакцией; недопустимый узел отменяет всю протяжку и подсвечивается красным. Сдвиг —drag с привязкой к ближайшей осевой клетке; легальные клетки подсвечиваются, нелегальные — красным, drop нелегальной возвращает узел и озвучивает причину. Стрелки сдвигают выбранный узел в соответствующем направлении, если операция легальна.

**Сохранение/перезапись.** «СОХРАНИТЬ» обновляет текущий `editingId`; если его нет — создаёт `customId()`. «СОХРАНИТЬ КОПИЕЙ» всегда новый id и переключает редактор на копию. Запись по id заменяет только эту трассу; по имени — никогда. Импорт с занятым id: диалог «Заменить / Импортировать копией / Отмена», по умолчанию — копия. Ошибка storage оставляет dirty и показывает `E_STORAGE`. Экспорт и тест-драйв не сбрасывают dirty; тест-драйв при dirty спрашивает подтверждение (как v1).

---

## 4. Геометрия, инварианты, валидаторы

`validateTrackSpec` остаётся авторитетом для runtime; `validateDraft` — строже и вызывается вместе с ним на каждом коммите. Если `toSpec` не проходит `validateTrackSpec`, операция невозможна.

| Инвариант | Правило | Где |
|---|---|---|
| Осевая смежность | каждое ребро между `q,r`-соседями (6 направлений); все road-узлы имеют целые `q,r` | `validateDraft`: `E_AXIAL` |
| Нет дублей | одна дорога/декор в клетке; декор не на дороге | `E_DUPLICATE_COORD` |
| Нет пересечений | сегменты не пересекаются, кроме общих концов; на гекс-сетке следует из смежности, проверка defensive | `E_CROSSING` |
| Замкнутый цикл | `main[i].next` содержит `main[i+1]`, последний → первый; длина 24–36; `spec.size === main.length` | `E_LOOP`, `E_LENGTH`, `E_SIZE` |
| Старт | ровно один `type:'start'`, на main, `main[0]===startNode`; старый старт погашен | `E_START_COUNT`, `E_START_INDEX` |
| Сетка 2×2 | 4 слота, 2 уникальных main-тайла, ровно `[main[n−1],main[n−1],main[n−2],main[n−2]]`, дорожные, без hazard/ramp/pit/fork/декора; конец ветки допустим (так у v1-подковы) | `E_GRID` |
| КП | ровно один не-стартовый, main, 25–65 %, `type:'checkpoint'`, не hazard/ramp/grid; `checkpoints=[start,cp]` | `E_CHECKPOINT` |
| Степени | main 1-вход/1-выход, кроме entry (2 выхода) и exit (2 входа); ветка 1/1; декора 0/0; `prev` — точная инверсия `next`, без дублей | `E_DEGREE` |
| Достижимость | все дорожные узлы достижимы из старта; каждая ветка от entry доходит до объявленного exit; нет висячих ссылок и циклов ветки | `E_REACHABILITY`, `E_BRANCH` |
| Опасности | ≤2 подряд с учётом замыкания; не на start/grid/CP/пите; ramp не на start/grid/CP; срез имеет ≥1 hazard | `E_HAZARD_RUN`, `E_HAZARD_ZONE`, `E_RAMP_ZONE`, `E_SHORTCUT` |
| Пит | tile XOR branch; branch: entry/exit на main, дистанция 2–5, узлов ≥2, ветка длиннее main-сегмента | `E_PIT` |
| Срез | entry/exit на main по **индексам** (не raw id): entry>3, exit<len−3; экономия 1–2; узлов ≥1; hazard ≥1 | `E_SHORTCUT` |
| Декор | без рёбер, `road:false`, только `building`/`ruin`, не в main/пите/срезе | `E_DECOR` |
| Хвост v1 | `nodes[i].id===i`, канонический порядок, все ссылки разрешены | `E_IDS`, `E_REF` |

**Легаси-нормализация.** В v1-«подкове» есть одно несоседнее ребро: узел 5 `[9,−1]` → узел 6 `[10,0]`. `migrateV1(spec)` при точном совпадении шаблона переставляет узлы 4 и 5 в `[8,0]`/`[9,0]` (36 тайлов сохраняются, 100/100 сидов проходят строгую проверку), ставит `source.migrated=['horseshoe-bump-v1']` и `W_MIGRATED_GEOMETRY`. Неизвестное несоседнее ребро → режим **read-only** (`E_READONLY_GEOMETRY`): просмотр, экспорт и тест-драйв разрешены, правки — нет. `track-gen.js` не меняется.

**Бюджет опасностей.** `E.generate` дополнительно возвращает `budget:{requestedMin,requestedMax,actual,achievable,ok}`; `maxGeneratedHazards` считается DP по main (кандидаты straight/turn, защищённые зоны исключены, без соседних hazard). При `actual < requestedMin` — `W_HAZARD_BUDGET` «Запрошено минимум N, размещено M; максимум для раскладки — K», слайдеры `max` синхронизируются с K. Молчаливого недобора нет; трасса остаётся валидной и сохраняемой.

---

## 5. Интерфейс (`#screen-constructor`)

```
header: [← В ГАРАЖ] ХРОМ И ПЕПЕЛ · конструктор   [↶][↷][СБРОС] [ИМПОРТ][ЭКСПОРТ] [СОХРАНИТЬ][КОПИЯ][ТЕСТ-ДРАЙВ]
main: 300px │ 1fr                                            │ 340px
 ПАРАМЕТРЫ  │ toolbar: [ВЫБОР V][КИСТЬ B][СДВИГ M]  [−][100%][+][ОБЗОР] │ ВЫБРАННЫЙ ТАЙЛ
 архетип/сид│ ┌──────────────────────────────────────────────┐ │  тип/позиция/роль/замки
 бюджет     │ │ #constructor-canvas (SVG, вся ширина)        │ │  [ВСТАВИТЬ][УДАЛИТЬ]
 [ГЕНЕРИРОВАТЬ]│ │ сетка, дороги, ветки, handles «+»         │ │  [СДЕЛАТЬ СТАРТОМ][СДЕЛАТЬ КП]
 ПАЛИТРА    │ └──────────────────────────────────────────────┘ │ ВАЛИДАЦИЯ: issue-rows (клик = выбор)
 полотно    │ stats: ТАЙЛОВ · ОПАСНОСТЕЙ · КП · ПИТ · СРЕЗ        │ СОХРАНЁННЫЕ: load/×
 опасности  │ #constructor-status (подсказка шага)              │
 особые     │ #constructor-live (sr-only, aria-live=polite)     │
```

**DOM:** сохраняются `#constructor-preview`, `#constructor-stats`, `#constructor-issues`, `#constructor-saved`, `#constructor-back/import/export/save/test/generate`; добавляются `#constructor-canvas`, `#constructor-toolbar`, `#constructor-tool-select/paint/move`, `#constructor-zoom-in/out/fit`, `#constructor-zoom-label`, `#constructor-undo/redo/reset`, `#constructor-save-copy`, `#constructor-palette` (кнопки `data-tile`), `#constructor-inspector` (`#constructor-node-title/pos/type`, `#constructor-lock-pos/type/remove`, `#constructor-insert/delete/make-start/make-cp`), `#constructor-status`, `#constructor-live`, `#constructor-dirty`. Рендер — `renderEditorSvg(draft, view)` в `track-editor-ui.js`: позиции берутся из `CnA.compileTrack(specFromDraft(draft))`, поэтому превью WYSIWYG с тест-драйвом; клики делегируются с `data-uid`, без слушателя на узел.

**Поведение холста.** Выбор: клик по узлу/пустоте. Кисть: клик/протяжка активным типом (транзакция). Вставка: «+» на середине ребра (при зуме ≥0.8) или Insert/Enter после выбранного. Сдвиг: drag с привязкой и подсветкой легальных клеток. Старт/КП: клик по узлу. Пит/срез: клик entry → клик exit → авто-маршрут и немедленный коммит; `Escape`/смена инструмента отменяют; подсказки в `#constructor-status`. ПКМ — снять выбор/отменить инструмент. Hover — подсказка с типом, координатой, ролью, замками. Выбранный узел — кольцо и handles; start/grid/CP — бейджи; срез/пит — те же штриховые рёбра, что в `previewSvg`.

**Зум/пан.** Колесо — зум к курсору, `−/+/0`, drag средней кнопкой или Space+ЛКМ; pinch на touch — best-effort, кнопки обязательны. Масштаб 0.5×–3× от fit; `ensureVisible` после undo/redo. Камера в history не входит.

**Клавиши (игнорируются в input/select/textarea/contenteditable):** V/B/M — инструменты; 1–0 — палитра; Insert/Enter — вставить после; Delete/Backspace — удалить; S/C — старт/КП; P/X — пит/срез; Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y — undo/redo; Ctrl/Cmd+S — сохранить; Ctrl/Cmd+Enter — тест-драйв; +/−/0 — зум/обзор; Esc — отмена/снять выбор; стрелки — сдвиг/навигация по узлам.

**Доступность.** `#constructor-canvas` — `role="group"` с `aria-describedby` на сводку; узлы — `<g role="button" tabindex="-1" aria-label="Тайл 12: поворот, КП, позиция 3,1">`, roving tabindex (выбранный `0`), стрелки водят фокус по геометрическим соседям, Enter применяет инструмент, Space выбирает. Палитра — `role="radiogroup"`, инструменты — `role="toolbar"` с `aria-pressed`. Инспектор — настоящие `<label>`/`<button>`/`<input type=checkbox>`. Issue-row — кнопка, фокусирует узел. `#constructor-live` озвучивает выбор, успех, отказ, undo/redo. `:focus-visible` — контрастное кольцо, не только цвет; touch-цели ≥44 px; `prefers-reduced-motion` отключает анимации; drag имеет кнопочные/клавиатурные альтернативы.

**Адаптив.** >1280: 3 колонки, `.constructor-screen{height:100dvh;overflow:hidden}`, `.constructor-main{flex:1;min-height:0}`, панели `overflow:auto`, холст `min-height:360px` — без прокрутки страницы. 900–1280: 260/1fr/300. <900: одна колонка, холст sticky `52vh`, палитра горизонтальной лентой, инспектор/валидация ниже, экран скроллится. <600: toolbar прокручивается, палитра 2–3 колонки, stats 2 колонки, отступы 8 px. Проверка: 1920×1080, 1366×768, 1024×768, 768×1024, 390×844 — `scrollWidth <= innerWidth`, панели не перекрывают холст.

---

## 6. Хранение и совместимость

- `TrackSpec` остаётся `schemaVersion:1`; новых обязательных полей нет. `size`, `grid`, `startNode`, `checkpoints`, `pit`, `shortcut`, `next/prev`, `decor` пересчитываются из draft; `archetype` сохраняется как «происхождение» (для UI/`startCustomTrack`), `layout:'axial'`, `hexSize`, `levels:1`, `theme:'dust'`.
- Ключ `cna.customTracks.v1`, `STORE_VERSION=1`, `MAX_TRACKS=40`, лимит импорта 100 КБ, форма `{kind:'cna-track',version:1,track:{id,name,createdAt,updatedAt,spec}}` — без изменений. Draft/UID/locks/history/selection **не** сохраняются и не экспортируются.
- `CnA.TrackEditor.report(normalizeEnvelope)` пропускает спеку через `canonicalizeSpec`; импорт с неразрешимыми ссылками отклоняется `E_IMPORT_REF`. Старые сохранения (в т.ч. подкова) открываются миграцией; неизвестная геометрия — read-only.
- `previewSvg` после патча: `esc(String(n.id))` в `data-node`; редактор дополнительно экранирует все атрибуты. Импорт не может внедрить HTML/JS через id/type/name/aria-label.
- Сервер, daily/PvP, API, `CreateGame` не меняются: сохраняется/экспортируется обычный валидный `TrackSpec`, который принимает существующий `startCustomTrack`.

---

## 7. Тесты

- **Unit (`node --test chrome-and-ash-web/tests`):** `canonicalizeSpec` на 100 сидах × 3 архетипах (dense id, refs, identity для генератов); `fromSpec→toSpec` канонический round-trip; миграция подковы и read-only fallback; стабильность UID; каждая операция — success/failure по таблице §3 с проверкой «исходник не изменён»; start-поворот+grid; КП/очистка старого; pit/shortcut дистанции/экономия/риск/висячие ссылки; locks; undo/redo/selection/focus; dirty/rollback; save/overwrite/copy; import collision; XSS-payload в id/type/name.
- **Property/invariant:** 500 детерминированных случайных операций над draft — каждая принятая даёт `validateDraft`+`validateTrackSpec` ok, каждая отклонённая оставляет draft deep-equal; undo всех операций возвращает исходник; нет дублей/несоседних рёбер/висячих ссылок; все id dense; `nodes[i].id===i`.
- **Browser E2E (`.deploy/qa-manual-editor.mjs`, CDP как `qa-e2e.mjs`):** generate → paint (3-я hazard отклонена) → insert/move/undo/redo → start/КП → pit/shortcut → save/reload → export/import → test-drive; invalid edits blocked; unsaved confirm; keyboard; XSS payload; 5 viewport-скриншотов без overflow; daily/PvP/free-race smoke.
- **Regression:** существующие `track-editor.test.mjs`, `track.test.mjs`, `balance.test.mjs`, `chrome-and-ash-web/verify.mjs`; 300 сидов free race; сохранённые v1-трассы открываются.

---

## 8. Этапы внедрения

| Этап | Содержание | Файлы | Критерий |
|---|---|---|---|
| B1 | `canonicalizeSpec`, `fromSpec/toSpec`, миграция, dense id | `track-editor.js`, тесты | round-trip 300 спек |
| B2 | ops select/paint/insert/remove/move + strict rollback | `track-editor.js`, тесты | таблица §3 зелёная |
| B3 | start/КП/grid, pit/shortcut, авто-маршруты | `track-editor.js`, тесты | фичи и инварианты §4 |
| B4 | session, history, locks, dirty, budget-report | `track-editor.js`, тесты | undo/property-тесты |
| B5 | каркас UI, canvas-рендер, выбор, зум/пан | `index.html`, `style.css`, `track-editor-ui.js` | E2E smoke, no overflow |
| B6 | палитра/кисть/инспектор/вставка/сдвиг/фичи | `track-editor-ui.js` | E2E edit-flow |
| B7 | save/copy/import/export, unsaved guard, read-only | `track-editor-ui.js`, `track-editor.js` | reload/round-trip |
| B8 | a11y, keyboard, responsive, XSS-проверки | `track-editor-ui.js`, `style.css` | чек-лист §5 |
| B9 | перф/регресс/приёмка, фиксация отклонений | тесты | полный прогон |

Правки `track-gen.js`/`engine.js`/`ui.js` в Stage B не планируются; если понадобятся — остановка и согласование с Lead. Обновление `05-track-construction.md` — отдельная задача документации, не разработчика.

---

## 9. Риски, крайние случаи, вне scope

| Риск | Митигация |
|---|---|
| Удаление в гекс-сетке часто незаконно | подсветка легальных клеток, точное сообщение, сценарий «вставь/сдвинь, потом удали» |
| Строгий коммит не даёт промежуточных состояний | все операции обратимы; сообщение объясняет, что сделать сначала; property-тесты на отсутствие тупиков |
| Авто-маршрут пита/среза не находит путь | bounded BFS/DFS по свободным клеткам, `E_*_NO_PATH`, undo; ручной редактор пути — вне Stage B |
| Несовпадение миграции подковы | точный шаблон + 100 сидов; иначе read-only, данные не теряются |
| Dense-id ремап ломает ссылки | единый `canonicalizeSpec` + property `nodes[i].id===i` |
| XSS из импорта | канонизация id + `esc()` + тест с payload |
| Undo память | 50 снапшотов × ~36 узлов, лимит |
| Квота localStorage | `E_STORAGE`, dirty сохраняется, экспорт доступен |
| Мобильный drag | явные режимы, кнопки, pinch best-effort |
| Оба branch-объекта неоднозначны для ИИ | запрещены одновременно; pit-тайл разрешён |
| Декор блокирует правку | декор вытесняется дорогой (`W_DECOR_CLEARED`), undo возвращает |
| Гонка вкладок | last-write-wins, отмечено как ограничение |
| Плохой импорт вне сетки | read-only, не блокирует просмотр/тест |

**Крайние случаи:** старт на предпоследнем тайле (grid захватывает начало), срез у КП, пит на grid, hazard на замыкании цикла, удаление последнего hazard среза, движение узла в клетку декора, undo после save, импорт с тем же id, пустое имя, storage недоступен, очень длинная ветка, неизвестный type, объектный `decor`.

**Вне scope:** серверная библиотека/share/ссылки (Stage C); schema v2; новые типы тайлов и механики; многоуровневые пересечения; редактор декора; multi-select/copy-paste; ручной редактор пути ветки; совместное редактирование; сохранение undo между reload; мобильные жесты сверх best-effort; изменение баланса/генератора.
