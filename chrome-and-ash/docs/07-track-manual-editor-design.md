# Ручной редактор трасс (этап B): проектное решение

**Статус:** проект Stage B поверх параметрического конструктора v1. Код приложения не меняется этим документом.
**Контракт:** `TrackSpec` `schemaVersion: 1` и localStorage-конверт `cna.customTracks.v1` остаются неизменными; ручная правка компилируется в обычный `TrackSpec`, который проверяет `CnA.validateTrackSpec`, компилирует `CnA.compileTrack` и принимает `createGame({trackSpec})`.
**Проверено при проектировании:** после нормализации известного дефекта «подковы» строгий draft-валидатор принял 300 сгенерированных спек (100 сидов × 3 архетипа); несоседних рёбер — 0.
**P0-ревью (ред. 2):** устранены 6 блокеров — wrap старта, validate-first + `canonicalizeRepresentation`, field-by-field `toSpec`, миграция/read-only, grid, таблица решений; сводка в §10.
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
- **Канонический порядок id:** main 0..M−1 → pit-ветка → shortcut-ветка → decor. Сначала **всегда** `CnA.validateTrackSpec(original)`; затем `canonicalizeRepresentation(spec)` только renumber/reorder/rotate (`nodes/main/grid/checkpoints/startNode/pit/shortcut/decor/next/prev`), **без починки топологии и без удаления ссылок**: dangling/duplicate → `E_REF`/`E_DUP_ID`, отказ. `next/prev` заново выводит только `toSpec`. Вход не мутируется; broken-spec `report` остаётся `false`.
- **`main[0] === startUid`.** Перенос старта поворачивает цикл: `main = [old[i], …, old[i−1]]`; `grid` немедленно пересобирается как `[main[n−1], main[n−1], main[n−2], main[n−2]]` (2 тайла × 2 машины), старый старт становится `straight`, новый — `start`. **Grid:** оба уникальных тайла — main road нормального типа (`straight`/`turn`), без hazard/ramp/pit-тайла/decor/CP/fork; **branch exit разрешён** (v1-подкова: `grid[0]=pit.exit`), branch entry/fork запрещены.
- **Dirty:** `fingerprint(toSpec(draft))` против `baselineFingerprint`; имя входит, locks/выбор/камера — нет. Мигрированная «подкова» кладётся в baseline → `dirty:false`; отдельный `unsavedNew` (нет `editingId`) охраняет выход. Reset возвращает мигрированный baseline, а не legacy; `W_MIGRATED` — один раз.
- **КП:** ровно один не-стартовый узел main с `type:'checkpoint'`, индекс 25–65 %; `checkpoints` всегда `[startUid, checkpointUid]`; старый КП становится `straight`.
- **Ветки:** `pit` — либо тайл на main, либо упорядоченная ветка entry→nodes→exit; `shortcut` — только ветка и обязан иметь ≥1 опасность. Одновременно допустим только один branch-объект (`pit.kind:'branch'` XOR `shortcut`); pit-тайл может сосуществовать со срезом.
- **Снапшоты:** `session.past/future`, до 50, `{draft:deepClone, selectionUid, focusUid, revision}`. Undo/redo восстанавливают draft, locks, выбор и focus; камера не откатывается, но `ensureVisible` доносит выбранный узел.
- **XSS-граница:** импорт/localStorage недоверенны. `canonicalizeRepresentation` делает id числовыми, `cleanName` чистит имя, любой вывод в SVG/HTML идёт через `esc()` — включая `data-node` в `previewSvg` (сейчас `n.id` вставляется сырым, строка 134) и `data-uid/type/aria-label/title` в новом рендере. Никаких `innerHTML` с `spec.name/env.name`; списки и инспектор — `textContent`.

---

## 3. Операции редактирования

### 3.1. Конвейер представления (validate-first)

1. `deepClone` входа; исходник не мутируется.
2. `CnA.validateTrackSpec(original)` — **валидируем оригинал** (dangling/duplicate refs, степени, ветки, start/CP/grid/pit/shortcut). Ошибка → отказ; `report(broken).ok === false` сохраняется.
3. `canonicalizeRepresentation(spec)` — renumber/reorder/rotate, не более; ссылки не теряются.
4. `migrateKnownHorseshoe(canonical)` — **rotation/order-invariant**: циклический поиск координатной последовательности `LEGACY_HORSESHOE_MAIN` (см. §4), типы/hazard/name/seed/бюджет игнорируются.
5. `validateStructural(canonical)` — **строгая структурная проверка редактора** (см. §3.2), не полагается на Stage A для wrap/branch/type/grid-entry.
6. `CnA.validateTrackSpec(canonical)` — повторно; успех → draft.
7. `toSpec(draft)` — **единственное место**, где выводятся `next/prev` и производные поля.

### 3.2. `validateStructural(spec)` — обязательный шаг

Вызывается **после canonicalization** в `report`, `normalizeEnvelope`, `import`, `load` и `pre-save` (не только в edit-ops). Возвращает `{ok, issues:[{code,message,nodeId?}]}`; любая ошибка блокирует сохранение/загрузку/импорт.

| Проверка | Код |
|---|---|
| shortcut/pit wraps start (`entry>=exit`, e.g. `entry=28→exit=2`) | `E_SHORTCUT_WRAP` / `E_PIT_WRAP` |
| оба branch-объекта одновременно | `E_BRANCH_CONFLICT` |
| неизвестный/недопустимый main type (`portal`) | `E_TYPE`; legacy `fork`-тип → read-only (§3.4) |
| grid на pit entry / структурный branch-fork; exit разрешён только на normal-type `main[n−1]`/`main[n−2]` | `E_GRID_ENTRY` / `E_GRID` |
| dangling refs | `E_REF` |
| duplicate node ids / coords | `E_DUP_ID` / `E_DUPLICATE_COORD` |
| bad degrees, branch connectivity | `E_DEGREE` / `E_BRANCH` |

Тесты (все четыре конструкции): wrapped `28→2` → `E_SHORTCUT_WRAP`; pit+shortcut → `E_BRANCH_CONFLICT`; main type `portal` → `E_TYPE`; grid на pit-entry/fork → `E_GRID_ENTRY`; плюс dangling/dup/degree → соответствующие коды. `validateStructural` не мутирует спеку.

### 3.3. `toSpec(draft)` — поле за полем

| Поле | Значение |
|---|---|
| `schemaVersion/layout/levels/theme` | `1`, `'axial'`, `1`, `'dust'` |
| `id/name/archetype/seed/hexSize/label` | из `draft.source`/`draft`; `label` добавляется только если был |
| `size/main/nodes[i].id/startNode/checkpoints` | `main.length`; `main[i]=i`; `nodes[i].id=i`; `startNode=0`; `[0, cpId]` |
| `grid` | `[n−1,n−1,n−2,n−2]` в плотных id |
| `x,y` | `x=hexSize*√3*(q+r/2)`, `y=hexSize*1.5*r`; входные x/y игнорируются, не-finite q/r → `E_COORD` |
| main-узел | `{id,q,r,x,y,type,next,prev,checkpoint:bool,pitLane:bool,level:0}`; `checkpoint:true` только КП, `pitLane:true` только pit-тайл |
| pit-branch узел | `{id,q,r,x,y,type:'pit',next,prev,pitLane:true,level:0}`; entry/exit `pitLane:false` |
| shortcut-узел | `{id,q,r,x,y,type,next,prev,inner:true,level:0}`; `inner` только здесь |
| decor-узел | `{id,q,r,x,y,type,next:[],prev:[],road:false,level:0}` |
| `pit/shortcut/decor` | плотные id; `shortcut.type` сохраняется, новая ветка — `debris` |
| `next/prev` | main-цикл + entry→ветка→exit; `prev` — точная инверсия |

Golden: `toSpec(fromSpec(generated))` deep-equal для `club`/`snake`; для `horseshoe` — deep-equal мигрированному эталону.

### 3.4. Таблица решений

| Вход | Решение |
|---|---|
| Валидный v1, неканонический порядок/ids/start не в `main[0]` | canonicalize → validateStructural → validate; если после поворота КП/ветка невалидны — read-only/reject по коду |
| Валидная «подкова» с известным bump (в т.ч. неканонический start/порядок) | canonicalize → rotation-invariant matcher → migrate → validateStructural → validate; baseline=migrated, `W_MIGRATED` один раз |
| Валидный v1, но неизвестное несоседнее ребро / объектный decor / `fork` / иной layout | **read-only**: `originalSpec` сохраняется; export/test разрешены; save выключен; save-copy только |
| Dangling refs, duplicate ids/coords, bad degrees/branch connectivity, оба branch-объекта, unknown road type, invalid start/CP/grid/pit/shortcut | **reject** через `validateStructural`: `E_REF/E_DUP_ID/E_DEGREE/E_BRANCH_CONFLICT/E_TYPE/E_GRID_ENTRY/E_IMPORT_*`; ничего не сохраняется |

### 3.5. Контракт операции

`CnA.TrackDraftSession.apply(op) → {ok, issues, selectionUid, requiresConfirm?}`: preflight без мутации → кандидат → `validateDraft` + `validateStructural` + `validateTrackSpec` → любая `E_*` откатывает операцию целиком (исходник/history не меняются); `W_*` не блокируют; успех — один снапшот. Кисть-протяжка — одна транзакция. `{force:true}` снимает **только** подтверждение замены/сброса, но не валидацию, не локи и не структурные инварианты.

| Операция | Предусловия | Коды и сообщения отказа |
|---|---|---|
| `paint(uid,type)` | узел road; `type` из палитры; не start/checkpoint/pit (для них инструменты); не заблокирован `type`; shortcut сохраняет ≥1 опасность; hazard/ramp не на start/grid/CP; hazards ≤2 подряд с учётом замыкания; tunnel/bridge только main | `E_NO_NODE` «Тайл не найден.»; `E_LOCKED_TYPE` «Тип тайла заблокирован.»; `E_PAINT_FEATURE` «Старт, КП и пит меняются инструментами.»; `E_TILE_ROLE` «Этот тип доступен только основной петле.»; `E_SHORTCUT_RISK` «На срезе должна остаться хотя бы одна опасность.»; `E_HAZARD_RUN` «Нельзя ставить третью опасность подряд.»; `E_HAZARD_ZONE`/`E_RAMP_ZONE` «Опасность/трамплин нельзя ставить на старт, решётку или КП.» |
| `insertBetween(fromUid,toUid)` | между ними есть ребро main/ветки; main < 36; пит после вставки ≥2; срез сохраняет экономию 1–2; есть свободная общая соседняя клетка; нет дубля/пересечения; feature-lock не запрещает | `E_INSERT_EDGE` «Между этими тайлами нет ребра.»; `E_LENGTH_MAX` «Круг уже максимальной длины (36).»; `E_INSERT_NO_CELL` «Нет свободной соседней клетки для нового тайла.»; `E_DUPLICATE_COORD` «Клетка уже занята.»; `E_CROSSING` «Новая дорога пересекает существующую.»; `E_LOCKED_FEATURE` «Объект заблокирован.» |
| `remove(uid)` | не start/CP/grid/branch-entry/exit; main > 24; после удаления соседи **соседние по осям** (в гекс-сетке законно только на изломе 60°); степень 1/1; ветки сохраняют длину/экономию/риск | `E_REMOVE_FEATURE` «Старт, КП, решётка и концы веток не удаляются — используйте инструмент.»; `E_LENGTH_MIN` «Круг уже минимальной длины (24).»; `E_REMOVE_GEOMETRY` «После удаления соседние тайлы не соприкасаются — сначала сдвиньте соседа.»; `E_LOCKED_REMOVE` «Тайл защищён от удаления.» |
| `move(uid,q,r)` | узел не заблокирован `pos`; клетка свободна от road (декор вытесняется, `W_DECOR_CLEARED`); узел остаётся соседним **всем** соединённым соседям (prev+next, включая ветки); дубль/пересечение запрещены; правила start/CP/pit/shortcut перепроверяются | `E_MOVE_OCCUPIED` «Клетка занята тайлом #N.»; `E_MOVE_ADJACENCY` «Тайл должен остаться соседним со всеми соседями по дороге.»; `E_CROSSING`; `E_LOCKED_POS` «Позиция тайла закреплена.» |
| `setStart(uid)` | main, не branch/декор; не hazard/ramp; не КП и не pit-тайл; не branch-entry/exit; новые grid-тайлы чистые; КП остаётся 25–65 %; **ветки не замыкаются через старт**; `type`-lock нового и старого старта | `E_START_ROLE`, `E_START_CP`, `E_START_ZONE`, `E_START_CP_RANGE`, `E_SHORTCUT_WRAP`, `E_PIT_WRAP`, `E_GRID`, `E_LOCKED_TYPE/FEATURE` |
| `setCheckpoint(uid)` | main, не start/grid/branch-entry/exit; индекс 25–65 %; не hazard/ramp; `type`-lock нового/старого КП | `E_CHECKPOINT_ROLE/RANGE/ZONE/GRID`, `E_LOCKED_TYPE/FEATURE` |
| `setPitTile(uid)` | main, не start/CP/grid/branch-endpoint; заменяет старый пит после confirm; `type`-lock | `E_PIT_ROLE`, `E_PIT_CONFLICT`, `E_LOCKED_TYPE/FEATURE` |
| `setPitBranch(entry,exit)` | оба main, разные; entry не start/CP/grid/чужой конец; exit не start/CP/чужой конец, **exit на grid разрешён, если это normal-type `main[n−1]`/`main[n−2]`**; entry/fork на grid запрещены; **entry<exit**; forward `exit−entry` = 2–5; авто-маршрут ≥2 узлов и длиннее main-сегмента; не обходит КП; нет hazard | `E_PIT_WRAP`, `E_PIT_DISTANCE`, `E_PIT_LENGTH`, `E_PIT_CP_BYPASS`, `E_PIT_NO_PATH`, `E_PIT_CONFLICT`, `E_GRID_ENTRY`, `E_LOCKED_FEATURE` |
| `setShortcut(entry,exit)` | оба main, разные, не start/CP/grid/чужие концы; **entry<exit**; entry>3, exit<len−3; forward `exit−entry−(nodes+1)` = 1–2; ≥1 узел и ≥1 hazard; нет пит-ветки | `E_SHORTCUT_WRAP`, `E_SHORTCUT_SAVING`, `E_SHORTCUT_NEAR_START`, `E_SHORTCUT_RISK`, `E_SHORTCUT_NO_PATH`, `E_SHORTCUT_CONFLICT`, `E_LOCKED_FEATURE` |
| `clearPit/clearShortcut()` | feature-lock снят; узлы ветки удаляются, pit-тайл → `straight`; `type`-lock пит-тайла | `E_LOCKED_FEATURE/TYPE` |
| `setLock(uid,flags)` | всегда; undo-шаг, но не dirty и не экспортируется | — |
| `undo()` / `redo()` | стек не пуст | `E_UNDO_EMPTY` «Нечего отменять.»; `E_REDO_EMPTY` «Нечего повторять.» |
| `reset()` | подтверждение; возвращает draft из `source.sourceSpec` (сгенерированный) или baseline сохранённой трассы, чистит history | — |

**P0-1 (замыкание старта).** Канонические индексы main: `entry<exit` обязательно; дистанции — только forward `exit−entry` (без modulo). `entry=n−1→exit=4` и `28→2` отклоняются `E_SHORTCUT_WRAP`/`E_PIT_WRAP` «Ветка замыкается через старт/финиш.» `setStart` пересобирает кандидат и перепроверяет оба кода на **всех** поворотах; если поворот делает ветку обёрточной — старт не переносится. **CP-bypass:** движок не требует КП для финиша (`finishCar`/пересечение старта), поэтому срез может обходить КП; точный warning — `W_SHORTCUT_CP_BYPASS` «КП пропущен; движок не требует КП для финиша». Пит обходить КП **запрещено** (`E_PIT_CP_BYPASS`) как правило дизайна (пит не срез), без ссылки на несуществующий штраф за круг. **Pit grid exit:** после `clearPit()` v1-подковы `setPitBranch(entry=main[33], exit=main[35])` должен успешно восстановить пит: exit — grid-тайл normal-type (`main[n−1]`), entry — нет; entry/fork на grid отклоняются `E_GRID_ENTRY`. Тесты: `n−1→4`, `28→2`, все стартовые ротации, clear/re-add пит 33→35.

**P1 (locks/pit UI).** Type-changing операции (`paint`, `setStart`, `setCheckpoint`, `setPitTile`, `clearPit`) проверяют `type`-lock и нового, и старого feature-узла; move/remove — `pos`/`remove`; создать/заменить ветку — `feature`. Пит-тайл и пит-ветка — **две отдельные кнопки палитры** `ПИТ-ТАЙЛ` (один клик по main) и `ПИТ-ВЕТКА` (entry→exit); статус-строка ведёт шаг, `Esc` отменяет, старый пит заменяется после confirm.

**Кисть и сдвиг.** Протяжка мышью красит все узлы под курсором одной транзакцией; недопустимый узел отменяет всю протяжку и подсвечивается красным. Сдвиг —drag с привязкой к ближайшей осевой клетке; легальные клетки подсвечиваются, нелегальные — красным, drop нелегальной возвращает узел и озвучивает причину. Стрелки сдвигают выбранный узел в соответствующем направлении, если операция легальна.

**Сохранение/перезапись.** «СОХРАНИТЬ» обновляет текущий `editingId`; если его нет — создаёт `customId()`. «СОХРАНИТЬ КОПИЕЙ» всегда новый id и переключает редактор на копию. Запись по id заменяет только эту трассу; по имени — никогда. Импорт с занятым id: диалог «Заменить / Импортировать копией / Отмена», по умолчанию — копия. Ошибка storage оставляет dirty и показывает `E_STORAGE`. Экспорт и тест-драйв не сбрасывают dirty; тест-драйв при dirty спрашивает подтверждение (как v1).

---

## 4. Геометрия, инварианты, валидаторы

`CnA.validateTrackSpec` остаётся авторитетом для runtime; `validateStructural` (§3.2) — строгий контракт редактора, вызываемый на report/import/load/save и на каждом коммите; `validateDraft` дополнительно проверяет draft-инварианты. Если `toSpec` не проходит любой из них, операция/сохранение невозможны.

| Инвариант | Правило | Где |
|---|---|---|
| Осевая смежность | каждое ребро между `q,r`-соседями (6 направлений); все road-узлы имеют целые `q,r` | `validateDraft`: `E_AXIAL` |
| Нет дублей | одна дорога/декор в клетке; декор не на дороге | `E_DUPLICATE_COORD` |
| Нет пересечений | сегменты не пересекаются, кроме общих концов; на гекс-сетке следует из смежности, проверка defensive | `E_CROSSING` |
| Замкнутый цикл | `main[i].next` содержит `main[i+1]`, последний → первый; длина 24–36; `spec.size === main.length` | `E_LOOP`, `E_LENGTH`, `E_SIZE` |
| Старт | ровно один `type:'start'`, на main, `main[0]===startNode`; старый старт погашен | `E_START_COUNT`, `E_START_INDEX` |
| Сетка 2×2 | ровно `[main[n−1],main[n−1],main[n−2],main[n−2]]`; оба уникальных — main road **normal type** (`straight`/`turn`); запрещены hazard/ramp/pit-тайл/decor/CP/fork; **branch exit разрешён только на normal-type `main[n−1]`/`main[n−2]`**, entry/fork запрещены (`E_GRID_ENTRY`); пересчёт на setStart/insert/remove/setPitBranch | `E_GRID`, `E_GRID_ENTRY` |
| КП | ровно один не-стартовый, main, 25–65 %, `type:'checkpoint'`, не hazard/ramp/grid; `checkpoints=[start,cp]` | `E_CHECKPOINT` |
| Степени | main 1-вход/1-выход, кроме entry (2 выхода) и exit (2 входа); ветка 1/1; декора 0/0; `prev` — точная инверсия `next`, без дублей | `E_DEGREE` |
| Достижимость | все дорожные узлы достижимы из старта; каждая ветка от entry доходит до объявленного exit; нет висячих ссылок и циклов ветки | `E_REACHABILITY`, `E_BRANCH` |
| Опасности | ≤2 подряд с учётом замыкания; не на start/grid/CP/пите; ramp не на start/grid/CP; срез имеет ≥1 hazard | `E_HAZARD_RUN`, `E_HAZARD_ZONE`, `E_RAMP_ZONE`, `E_SHORTCUT` |
| Пит | tile XOR branch; branch: entry<exit, forward 2–5, узлов ≥2, длиннее main-сегмента, **не обходит КП** | `E_PIT`, `E_PIT_WRAP`, `E_PIT_CP_BYPASS` |
| Срез | entry<exit, forward-экономия 1–2, entry>3, exit<len−3, узлов ≥1, hazard ≥1; CP-bypass — warning «КП пропущен; движок не требует КП для финиша» | `E_SHORTCUT`, `E_SHORTCUT_WRAP`, `W_SHORTCUT_CP_BYPASS` |
| Декор | без рёбер, `road:false`, только `building`/`ruin`, не в main/пите/срезе | `E_DECOR` |
| Хвост v1 | `nodes[i].id===i`, канонический порядок, все ссылки разрешены | `E_IDS`, `E_REF` |

**Миграция (P0-4, ред. 3).** Конвейер: `fromSpec → validateTrackSpec(original) → canonicalizeRepresentation → migrateKnownHorseshoe → validateStructural → validateTrackSpec` (порядок §3.1). Canonicalization выполняется **до** matcher; matcher **rotation/order-invariant**: циклически ищет 36-координатную последовательность `LEGACY_HORSESHOE_MAIN` (координаты `[8,−1]`,`[9,−1]`,`[10,0]` подряд в этом порядке), поэтому неканонический `startNode`/порядок тоже распознаётся. Найденный offset задаёт три узла: два средних → `[8,0]`/`[9,0]`, третий остаётся `[10,0]`; типы, hazard, имя, seed, бюджет игнорируются. Совпадение → `source.migrated=['horseshoe-bump-v1']`, `W_MIGRATED_GEOMETRY` один раз; `baseline` = мигрированная спека (`dirty:false`), `reset` возвращает её, `unsavedNew` отдельно охраняет выход. `club`/`snake` — строгая identity (`toSpec(fromSpec(x))` deep-equal x). Несовпадение при несоседнем ребре → **read-only** с сохранённым `originalSpec`; правки запрещены, export/test разрешены, save выключен, save-copy только. `track-gen.js` не меняется. Тесты: 100 сидов × бюджеты `[0,0]`, `[2,2]`, `[5,5]`, `[6,6]`; отдельно — та же подкова с неканоническим `startNode` и повёрнутым `main`; миграция один раз; reset в мигрированный baseline.

**Бюджет hazard (P1).** `maxPaintHazards` — DP по циклу main с состояниями `run∈{0,1,2}` (защищённые зоны = 0), точный максимум при правиле ≤2 подряд. `maxGeneratedHazards` — тот же DP с `run≤1` по кандидатам straight/turn (генератор не ставит hazard рядом). DP проверяется brute-force для n=6..12 и случайных защищённых масок. `E.generate` возвращает `budget:{requestedMin,requestedMax,actual,achievable,ok}`; при `actual<requestedMin` — `W_HAZARD_BUDGET` «Запрошено минимум N, размещено M; максимум — K», `max` слайдера = achievable; молчаливого недобора нет.

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

**DOM:** сохраняются `#constructor-preview`, `#constructor-stats`, `#constructor-issues`, `#constructor-saved`, `#constructor-back/import/export/save/test/generate`; добавляются `#constructor-canvas`, `#constructor-toolbar`, `#constructor-tool-select/paint/move`, `#constructor-zoom-in/out/fit`, `#constructor-zoom-label`, `#constructor-undo/redo/reset`, `#constructor-save-copy`, `#constructor-palette` (`data-tile`, включая отдельные `pit-tile` и `pit-branch`), `#constructor-inspector` (`#constructor-node-title/pos/type`, `#constructor-lock-pos/type/remove`, `#constructor-insert/delete/make-start/make-cp`), `#constructor-status`, `#constructor-live`, `#constructor-dirty`. Рендер — чистый экспортируемый `CnA.TrackDraft.renderEditorSvg(draft, view)` (тестируется в Node), позиции — из `CnA.compileTrack(toSpec(draft))`, клики делегируются по `data-uid`.

**Поведение холста.** Выбор: клик по узлу/пустоте. Кисть: клик/протяжка активным типом (транзакция). Вставка: «+» на середине ребра (при зуме ≥0.8) или Insert/Enter после выбранного. Сдвиг: drag с привязкой и подсветкой легальных клеток. Старт/КП: клик по узлу. Пит/срез: клик entry → клик exit → авто-маршрут и немедленный коммит; `Escape`/смена инструмента отменяют; подсказки в `#constructor-status`. ПКМ — снять выбор/отменить инструмент. Hover — подсказка с типом, координатой, ролью, замками. Выбранный узел — кольцо и handles; start/grid/CP — бейджи; срез/пит — те же штриховые рёбра, что в `previewSvg`.

**P1 UI.** Пит-тайл — отдельная кнопка `ПИТ-ТАЙЛ` (один клик по main); пит-ветка — `ПИТ-ВЕТКА` (entry→exit); статус-строка ведёт шаг, `Esc` отменяет, старый пит заменяется после confirm. Локальный `toast()` передаёт в `CnA.UI.showToast` уже `esc(String(text))` — имена/типы не идут сырыми в HTML. Неизвестный type рендерится fallback `CnA.TILES.straight` с `esc`; unknown road type отклоняется на входе (read-only только известный `fork`). x/y не принимаются от пользователя: `toSpec` выводит из q/r, для read-only рендера — `Number.isFinite`-коэрция, валидатор даёт `E_COORD`.

**Зум/пан.** Колесо — зум к курсору, `−/+/0`, drag средней кнопкой или Space+ЛКМ; pinch на touch — best-effort, кнопки обязательны. Масштаб 0.5×–3× от fit; `ensureVisible` после undo/redo. Камера в history не входит.

**Клавиши (игнорируются в input/select/textarea/contenteditable):** V/B/M — инструменты; 1–0 — палитра; Insert/Enter — вставить после; Delete/Backspace — удалить; S/C — старт/КП; P/X — пит/срез; Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y — undo/redo; Ctrl/Cmd+S — сохранить; Ctrl/Cmd+Enter — тест-драйв; +/−/0 — зум/обзор; Esc — отмена/снять выбор; стрелки — сдвиг/навигация по узлам.

**Доступность.** `#constructor-canvas` — `role="group"` с `aria-describedby` на сводку; узлы — `<g role="button" tabindex="-1" aria-label="Тайл 12: поворот, КП, позиция 3,1">`, roving tabindex (выбранный `0`), стрелки водят фокус по геометрическим соседям, Enter применяет инструмент, Space выбирает. Палитра — `role="radiogroup"`, инструменты — `role="toolbar"` с `aria-pressed`. Инспектор — настоящие `<label>`/`<button>`/`<input type=checkbox>`. Issue-row — кнопка, фокусирует узел. `#constructor-live` озвучивает выбор, успех, отказ, undo/redo. `:focus-visible` — контрастное кольцо, не только цвет; touch-цели ≥44 px; `prefers-reduced-motion` отключает анимации; drag имеет кнопочные/клавиатурные альтернативы.

**Адаптив.** >1280: 3 колонки, `.constructor-screen{height:100dvh;overflow:hidden}`, `.constructor-main{flex:1;min-height:0}`, панели `overflow:auto`, холст `min-height:360px` — без прокрутки страницы. 900–1280: 260/1fr/300. <900: одна колонка, холст sticky `52vh`, палитра горизонтальной лентой, инспектор/валидация ниже, экран скроллится. <600: toolbar прокручивается, палитра 2–3 колонки, stats 2 колонки, отступы 8 px. **1024 header:** `.constructor-top{flex-wrap:wrap;row-gap:6px}`, `.constructor-actions{flex-wrap:wrap;justify-content:flex-end}`, brand `min-width:0`, `#constructor-mode` скрыт <1100 — без горизонтального overflow. Проверка: 1920×1080, 1366×768, **1024×768**, 768×1024, 390×844 — `scrollWidth <= innerWidth`, панели не перекрывают холст.

---

## 6. Хранение и совместимость

- `TrackSpec` остаётся `schemaVersion:1`; новых обязательных полей нет. `size`, `grid`, `startNode`, `checkpoints`, `pit`, `shortcut`, `next/prev`, `decor` пересчитываются из draft; `archetype` сохраняется как «происхождение» (для UI/`startCustomTrack`), `layout:'axial'`, `hexSize`, `levels:1`, `theme:'dust'`.
- Ключ `cna.customTracks.v1`, `STORE_VERSION=1`, `MAX_TRACKS=40`, лимит импорта 100 КБ, форма `{kind:'cna-track',version:1,track:{id,name,createdAt,updatedAt,spec}}` — без изменений. Draft/UID/locks/history/selection **не** сохраняются и не экспортируются.
- **Единый pipeline:** `report`, `normalizeEnvelope`, `import`, `load`, `pre-save` вызывают `validateTrackSpec(original) → canonicalizeRepresentation → migrateKnownHorseshoe (cyclic) → validateStructural → validateTrackSpec`. `validateStructural` — обязательный шаг **после** canonicalization, не только для edit-ops; именно он (а не Stage A) отклоняет wrapped-ветки, оба branch-объекта, unknown main type, grid на pit-entry/fork, dangling/dup/degrees. Сломанная спека не «чинится» и остаётся `ok:false`.
- **Read-only policy:** неизвестная/несовместимая геометрия сохраняет `originalSpec`; редактирование и `СОХРАНИТЬ` выключены, `ЭКСПОРТ` и `ТЕСТ-ДРАЙВ` идут по оригиналу, доступна только `СОХРАНИТЬ КОПИЕЙ` (новый конверт с исходной спекой, при повторном открытии снова read-only). `reset`/undo в read-only недоступны.
- Миграция: `baseline` = мигрированная спека, `dirty:false`, `reset` возвращает её, `W_MIGRATED` один раз; `unsavedNew` охраняет выход отдельно. `originalSpec` нужен только для read-only/диагностики и не попадает в конверт.
- `previewSvg` после патча: `esc(String(n.id))` в `data-node`; редактор дополнительно экранирует все атрибуты. Импорт не может внедрить HTML/JS через id/type/name/aria-label.
- Сервер, daily/PvP, API, `CreateGame` не меняются: сохраняется/экспортируется обычный валидный `TrackSpec`, который принимает существующий `startCustomTrack`.

---

## 7. Тесты

- **Unit (`node --test chrome-and-ash-web/tests`):** validate-first/canonicalize на 100×3 (dense id, refs, идемпотентность, immutable input, `report(broken).ok===false`, dangling не удаляются); **`validateStructural` на report/import/load/save**: wrapped `28→2`, оба branch-объекта, main type `portal`, grid на pit-entry/fork, dangling/dup/degrees → точные коды; `toSpec` golden field-by-field §3.3 для club/snake и мигрированной подковы; миграция 100 сидов × `[0,0]/[2,2]/[5,5]/[6,6]` + **неканонический start/порядок подковы**; clearPit→setPitBranch(33→35) для v1-подковы; start/grid/КП; **wrap `n−1→4`, `28→2`, все стартовые ротации**; grid `grid[0]=pit.exit`; locks type-changing; **budget DP vs brute-force n=6..12**; undo/redo/selection/focus; dirty/rollback; save/overwrite/copy; import collision; read-only policy; XSS-payload в id/type/name и `showToast`; CP-bypass warning не обещает штраф за круг.
- **Property/invariant:** 500 детерминированных случайных операций над draft — каждая принятая даёт `validateDraft`+`validateTrackSpec` ok, каждая отклонённая оставляет draft deep-equal; undo всех операций возвращает исходник; нет дублей/несоседних рёбер/висячих ссылок; все id dense; `nodes[i].id===i`.
- **Browser E2E (`.deploy/qa-manual-editor.mjs`, CDP как `qa-e2e.mjs`):** generate → paint (3-я hazard отклонена) → insert/move/undo/redo → start/КП → pit/shortcut → save/reload → export/import → test-drive; invalid edits blocked; unsaved confirm; keyboard; XSS payload; 5 viewport-скриншотов без overflow; daily/PvP/free-race smoke.
- **Regression:** существующие `track-editor.test.mjs`, `track.test.mjs`, `balance.test.mjs`, `chrome-and-ash-web/verify.mjs`; 300 сидов free race; сохранённые v1-трассы открываются.

---

## 8. Этапы внедрения

| Этап | Содержание | Файлы | Критерий |
|---|---|---|---|
| B1 | validate-first, `canonicalizeRepresentation`, `fromSpec/toSpec`, миграция, dense id | `track-editor.js`, тесты | golden + 100×4 |
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
| Dense-id ремап ломает ссылки | единый `canonicalizeRepresentation` + property `nodes[i].id===i` |
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

---

## 10. P0-решения ревью (ред. 2)

| P0 | Точное решение | Тест/критерий |
|---|---|---|
| P0-1 wrap/CP | `entry<exit` в канонических индексах; forward-дистанции `exit−entry` без modulo; `E_SHORTCUT_WRAP/E_PIT_WRAP`; `setStart` перепроверяет все повороты; срез может обходить КП (`W_SHORTCUT_CP_BYPASS` «КП пропущен; движок не требует КП для финиша»), пит — нет (`E_PIT_CP_BYPASS`) | `n−1→4`, `28→2`, все ротации |
| P0-2 canonicalize | `validateTrackSpec(original)` → `canonicalizeRepresentation` (renumber/reorder/rotate only, без repair/drop) → migrate → validateStructural → validate; input immutable; broken `report` false; dangling → `E_REF` | broken/dangling/immutability |
| P0-3 toSpec | field-by-field §3.3: x/y из q/r+hexSize; `checkpoint` только КП; `pitLane` только pit-тайл/ветка; `inner` только shortcut; `road:false` decor; `level:0`; `size`; dense `main/nodes/startNode=0/checkpoints=[0,cp]/grid`; remap pit/shortcut/decor; `label/shortcut.type` | golden deep-equal |
| P0-4 migration | canonicalize → rotation-invariant cyclic matcher → migrate → validateStructural; ignores types/hazard/name/seed/budget; identity только club/snake; baseline=migrated, dirty:false, reset migrated, `W_MIGRATED` once; non-match read-only с `originalSpec`; 100×4 бюджета + неканонический start/order | миграция/read-only |
| P0-5 grid | ровно `[last,last,prev,prev]`; оба main road normal type; hazard/ramp/pit/decor/CP/fork запрещены; **branch exit разрешён только на normal-type `main[n−1]`/`main[n−2]`**, entry/fork запрещены (`E_GRID_ENTRY`); revalidate на setStart/insert/remove/setPitBranch | v1 horseshoe `grid[0]=pit.exit` |
| P0-6 decisions | canonicalize / migrate / read-only (export/test + save-copy) / reject; оба branch-объекта reject; dangling/dupes/degrees/branches/unknown type/invalid features reject; read-only не теряет оригинал | по одному тесту на класс |

---

## 11. Второе ревью (task-8): точные исправления

| № | Исправление | Проверка |
|---|---|---|
| 1 | `setPitBranch`: **exit на grid разрешён**, если это normal-type `main[n−1]`/`main[n−2]`; entry/fork на grid запрещены (`E_GRID_ENTRY`). Clear/re-add v1-подковы: `clearPit()` → `setPitBranch(entry=main[33], exit=main[35])` успешен, exit — grid normal-type. | тест 33→35 |
| 2 | Добавлен `validateStructural(spec)`: обязательный шаг **после canonicalization** в `report`/`normalizeEnvelope`/`import`/`load`/`pre-save`, не только в edit-ops. Коды: wrapped `28→2` → `E_SHORTCUT_WRAP`; pit+shortcut → `E_BRANCH_CONFLICT`; main type `portal` → `E_TYPE` (legacy `fork` → read-only); grid на pit-entry/структурный fork → `E_GRID_ENTRY`; dangling/dup/degrees → `E_REF`/`E_DUP_ID`/`E_DEGREE`. Stage A для этих четырёх конструкций не используется. | 4 конструкта + refs |
| 3 | CP-bypass приведён к неизменному движку: `finishCar`/пересечение старта **не требует КП**; ложное «круг не засчитается» удалено; warning `W_SHORTCUT_CP_BYPASS` = «КП пропущен; движок не требует КП для финиша»; пит-bypass остаётся запрещён как правило дизайна (`E_PIT_CP_BYPASS`), без ссылки на штраф. | текст + engine-факт |
| 4 | Порядок миграции: `validate original → canonicalizeRepresentation → migrateKnownHorseshoe`; matcher **rotation/order-invariant** (циклический поиск `LEGACY_HORSESHOE_MAIN`), поэтому неканонический `startNode`/порядок распознаётся. | подкова с неканон. start/order |

