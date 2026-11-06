# ХРОМ И ПЕПЕЛ — протокол PvP (фаза 2)

**Версия контракта:** 1.0
**Статус:** предложение (wire-контракт для реализации фазы 2)
**Продолжает:** `chrome-and-ash-web/docs/06-web-api.md` §8 «Готовность к фазе 2».
**Сопутствующие артефакты:**
- `server/schema.sql` — таблицы `games`, `game_players` (миграция v1→v2);
- `server/api-schemas.json` — JSON Schema фазы 1 (PvP-схемы добавляются при реализации).

Этот документ фиксирует договор фазы 2 (PvP) так, чтобы **фаза 1 не переписывалась**: REST auth/профиля/сохранений/лидербордов остаётся, а PvP добавляет WebSocket-канал `/ws`, новые REST-ресурсы `/api/lobbies/*` и две таблицы БД.

---

## 1. Обзор и принятая архитектура

- **Сервер авторитетен.** Каноническое состояние партии хранится на сервере (`games.state`, JSON-блоб движка со всеми руками и колодами). Сервер принимает действия игроков, применяет их детерминированным движком `CnA`, инкрементирует `seq` и рассылает **проекции** (состояние без чужих рук).
- **Клиент — тонкий.** Клиент отправляет действия (`play_card`, `roll`, `end_turn`, …) и рендерит последнюю полученную проекцию. Локальный оптимистичный превью допустим, но канон — сервер.
- **Детерминизм.** Движок воспроизводим по `seed` (тот же `CnA.createGame`), поэтому сервер может переигрывать/проверять ходы. Поле `seed` уже есть в конверте фазы 1.
- **Один общий канал.** Все live-сообщения идут через `/ws`; лобби-менеджмент (создать/вступить/покинуть/старт) дублируется REST для удобства и переживает перезагрузку страницы.

---

## 2. Транспорт и аутентификация

- **Эндпоинт:** `GET /ws` (WebSocket upgrade).
- **Аутентификация:** та же сессия фазы 1 — cookie `cna_session` участвует в WebSocket-хендшейке. Отдельный `Authorization`/токен не нужен.
- **Origin:** сервер проверяет `Origin` при апгрейде (защита от cross-site WebSocket hijacking): при наличии заголовка разрешаются same-origin (совпадение с `Host`), `localhost`/`127.0.0.1` и значения из `ALLOWED_ORIGINS`; иначе соединение закрывается с кодом `4003`.
- **После успешного хендшейка** сервер сразу шлёт `hello`.

```
Client                          Server
  |──── GET /ws (cookie) ───────▶|
  |◀──────── hello ──────────────|
  |──── join_lobby {code} ──────▶|
  |◀── lobby_update / state ─────|
  |──── play_card / roll / … ───▶|
  |◀────────── state ────────────|
```

Соединение привязывается к лобби сообщением `join_lobby` (это же сообщение используется при переподключении). Пока соединение не привязано, игровые действия отклоняются `error` (`not_joined`).

---

## 3. Конверт сообщений и общие правила

Все сообщения — JSON-объекты с обязательным строковым полем `type`.

**Общие поля клиентских сообщений:**

| Поле | Тип | Назначение |
|---|---|---|
| `type` | string | тип сообщения |
| `ackSeq` | int \| null | последний принятый клиентом `seq` (для детекции рассинхрона) |
| `clientId` | string \| null | идемпотентный ключ действия (клиент генерирует UUID; сервер дедуплицирует повторы по `(slot, clientId)`) |

**Правила обработки:**

1. Действия применяются только к текущему ходу (`your_turn`) авторизованного слота; иначе `error` (`not_your_turn`).
2. Каждое применённое действие инкрементирует `games.seq` и рассылает `state` всем участникам.
3. Если `ackSeq < games.seq` (клиент пропустил кадры), сервер всё равно шлёт **полную проекцию** в следующем `state` — дельты в фазе 2 v1 не используются, поэтому рассинхрон лечится автоматически.
4. Повтор действия с тем же `clientId` не применяется повторно; сервер отвечает текущим `state`.

---

## 4. Сообщения WebSocket

### 4.1. Клиент → сервер

| `type` | Поля | Назначение |
|---|---|---|
| `join_lobby` | `lobbyCode` | привязать соединение к лобби (первый вход и переподключение) |
| `start_game` | `lobbyCode?` | владелец запускает игру (эквивалент REST `/start`) |
| `play_card` | `uid`, `target?`, `node?`, `targets?` | сыграть карту арсенала |
| `roll` | — | бросок движения (фаза подготовка → движение) |
| `choose_route` | `nodeId` | выбрать маршрут на развилке (после `route_choice`) |
| `pit` | — | пит-стоп (фаза подготовки, если машина на пит-лейне) |
| `ability` | `id` | способность фракции/улучшения (см. ниже) |
| `end_turn` | — | завершить ход |
| `resign` | — | сдаться (слот → bot, см. §9) |
| `ping` | `t?` | keepalive; сервер отвечает `pong` |

**`ability.id`** — точки ручного решения в движке (остальные способности срабатывают автоматически):

| `id` | Способность | Движок |
|---|---|---|
| `rust` | «Латаем на ходу» (Кузнецы Ржавчины) | `CnA.useRustRepair` |
| `returnMine` | «Оставь им подарок» (Карнавал Боли) | `CnA.returnMine` |
| `turbo` | «Турбина на выхлопе» (улучшение) | `CnA.armTurbo` |

Автоматические (без сообщения): Хром — двойной d4 тарана; Стая — дальность +1 и +2 по лидеру.

**`play_card` подробнее** (`uid` — uid карты из руки игрока, как в движке):

| Карта | Нужные поля |
|---|---|
| атака (кроме `twin`) | `uid`, `target` (carId цели) |
| `twin` | `uid`, `targets` (массив из двух carId) |
| ловушка (`mine`/`oil`) | `uid`, `node` (id тайла) |
| карта подготовки / прочее | `uid` |

Примеры:

```json
{ "type": "play_card", "uid": 41, "target": 2, "ackSeq": 17, "clientId": "0194…" }
{ "type": "play_card", "uid": 12, "node": 9, "ackSeq": 17, "clientId": "0194…" }
{ "type": "roll", "ackSeq": 17, "clientId": "0194…" }
{ "type": "end_turn", "ackSeq": 17, "clientId": "0194…" }
```

### 4.2. Сервер → клиент

| `type` | Поля | Назначение |
|---|---|---|
| `hello` | `protocolVersion`, `accountId`, `now` | подтверждение хендшейка |
| `lobby_update` | `lobby` | состояние лобби (слоты, статус, владелец) |
| `game_start` | `gameId`, `config`, `players`, `seq` | игра началась |
| `state` | `seq`, `projection` | полная проекция состояния (per-viewer) |
| `your_turn` | `slot`, `carId`, `deadline?` | настал ход слота |
| `route_choice` | `from`, `options` | развилка на маршруте: нужно выбрать `nodeId`; `options` — массив объектов `{node, jump, via}` (см. §8) |
| `turn_timeout` | `slot`, `remainingMs` | остаток таймера хода (см. §8) |
| `result` | `gameId`, `standings`, `runs` | игра окончена |
| `opponent_left` | `slot`, `accountId?`, `displayName?`, `reason`, `controllerNow` | игрок вышел/сдался |
| `reconnect_ok` | `slot`, `seq`, `projection` | успешное переподключение (полная проекция) |
| `pong` | `t` | ответ на `ping` |
| `error` | `code`, `message`, `details?` | ошибка действия |

Пример `state` (проекция одного игрока):

```json
{
  "type": "state",
  "seq": 18,
  "projection": {
    "version": "0.1.0", "mode": "race", "seed": 812345, "laps": 1,
    "trackKind": "mosaic", "trackSize": 36, "raceIndex": 0, "stage": "race",
    "cars": [
      { "id": 0, "factionId": "rust", "hp": 22, "maxHp": 22, "node": 3,
        "hand": [{ "uid": 41, "type": "rocket" }, { "uid": 42, "type": "nitro" }],
        "scrap": 0, "cp": 0, "human": true, "finished": false, "destroyed": false },
      { "id": 1, "factionId": "chrome", "hp": 18, "maxHp": 18, "node": 5,
        "hand": { "hidden": true, "count": 3 },
        "scrap": 0, "cp": 0, "human": false, "finished": false, "destroyed": false }
    ],
    "race": { "round": 1, "currentId": 0, "phase": "prep",
      "deck": { "hidden": true, "count": 55 },
      "eventDeck": { "hidden": true, "count": 30 },
      "discard": ["mg", "smoke"], "eventDiscard": ["sandstorm"],
      "tokens": [], "order": [0, 1, 2, 3], "track": { "nodes": [] } },
    "log": []
  }
}
```

---

## 5. Лобби REST

Базовый префикс `/api`. Все эндпоинты требуют сессию фазы 1 (кроме явно отмеченных).

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| POST | `/api/lobbies` | да | создать лобби (владелец = создатель, slot 0) |
| GET | `/api/lobbies/:code` | да | состояние лобби |
| POST | `/api/lobbies/:code/join` | да | занять свободный слот |
| POST | `/api/lobbies/:code/leave` | да | покинуть лобби |
| POST | `/api/lobbies/:code/start` | да | владелец запускает игру |

- **Код лобби** — 6 символов base32 (без `0/1/O/I`), верхний регистр; генерируется сервером при создании. Пример: `K7P2QA`.
- **4 слота** (0–3). Слот 0 зарезервирован за владельцем. Свободные слоты при старте заполняются ботами (`controller=bot`).
- **Статусы:** `waiting` (сбор) → `playing` (идёт) → `finished` (сыграна).
- **Владелец** — создатель; только владелец может `start` (и менять конфиг в `waiting`).

### 5.1. `POST /api/lobbies`

**Запрос:**

```json
{
  "type": "object",
  "required": [],
  "properties": {
    "config": { "$ref": "#/$defs/PvpLobbyConfig" }
  },
  "additionalProperties": false
}
```

`PvpLobbyConfig`:

```json
{
  "type": "object",
  "properties": {
    "turnTimerSeconds": { "type": ["integer", "null"], "minimum": 10, "maximum": 300 },
    "trackKind": { "enum": ["ring", "mosaic"] },
    "trackSize": { "type": "integer", "minimum": 24, "maximum": 36 },
    "laps": { "enum": [1, 2] },
    "seed": { "type": ["integer", "null"] },
    "rejoinWindowSeconds": { "type": "integer", "minimum": 0, "maximum": 3600 }
  },
  "additionalProperties": false
}
```

Умолчания: `turnTimerSeconds=90`, `trackKind="mosaic"`, `trackSize=36`, `laps=1`, `seed=null` (случайный), `rejoinWindowSeconds=300`.

**Ответ `201 Created`:**

```json
{ "lobby": { "code": "K7P2QA", "ownerAccountId": "…", "status": "waiting",
  "config": { "turnTimerSeconds": 90, "trackKind": "mosaic", "trackSize": 36, "laps": 1, "seed": null, "rejoinWindowSeconds": 300 },
  "slots": [ { "slot": 0, "accountId": "…", "displayName": "Водила", "faction": null, "controller": "human", "connected": false } ] } }
```

### 5.2. `GET /api/lobbies/:code`

Возвращает `{ "lobby": { …то же, что и в 5.1, с актуальными slots… } }`. Ошибки: `404 not_found` (нет лобби), `409 finished` (лобби сыграно — отдаётся как finished, без join).

### 5.3. `POST /api/lobbies/:code/join`

Без тела. Игрок занимает первый свободный слот (`controller=human`). Ошибки: `404 not_found`, `409 lobby_full` (все 4 заняты), `409 already_joined` (уже в лобби), `409 not_waiting` (лобби уже `playing`/`finished`).

Ответ `200`: тот же `{ "lobby": … }`.

### 5.4. `POST /api/lobbies/:code/leave`

Без тела. Покинуть лобби. Если уходит владелец в статусе `waiting` — лобби расформировывается (или владение передаётся следующему; по умолчанию — расформировать). В `playing` leave обрабатывается как разрыв (§9): слот → bot, `opponent_left`.

Ответ `204 No Content`.

### 5.5. `POST /api/lobbies/:code/start`

Без тела, только владелец (`403 forbidden` иначе). Переводит `waiting → playing`: генерирует игру (`seed`, трассу), заполняет пустые слоты ботами, инициализирует `games.state`, рассылает `game_start` + первый `state` по WS. Ошибки: `404`, `409 not_waiting`, `409 not_enough_players` (нужно ≥ 1 человека; по умолчанию можно стартовать и в одиночку — остальные боты).

---

## 6. Схема БД (миграция v1 → v2)

Добавляется в `server/schema.sql` (все операторы `IF NOT EXISTS`, идемпотентно). `PRAGMA user_version` повышается с 1 до 2.

```sql
PRAGMA user_version = 2;

CREATE TABLE IF NOT EXISTS games (
  id               TEXT PRIMARY KEY,              -- UUIDv7
  lobby_code       TEXT NOT NULL UNIQUE,          -- 6 симв. base32
  owner_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','finished')),
  config_json      TEXT NOT NULL,                 -- JSON PvpLobbyConfig
  state            TEXT,                          -- JSON: полное состояние движка (все руки/колоды)
  seq              INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

CREATE TABLE IF NOT EXISTS game_players (
  game_id         TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  account_id      TEXT REFERENCES accounts(id) ON DELETE CASCADE, -- NULL для bot-слота
  slot            INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 3),
  controller      TEXT NOT NULL DEFAULT 'bot' CHECK (controller IN ('human','bot')),
  faction         TEXT CHECK (faction IN ('chrome','rust','carnival','swarm')),
  joined_at       TEXT NOT NULL,
  disconnected_at TEXT,
  PRIMARY KEY (game_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_game_players_account ON game_players(account_id);
```

Пояснения:

- **`games.state`** — канонический JSON-блоб движка (та же сериализуемая форма, что и `SaveState.engine` фазы 1, но БЕЗ удаления рук/колод — серверу нужны все руки). `NULL`, пока игра не стартовала.
- **`games.seq`** — монотонный номер состояния, инкрементируется на каждое применённое действие.
- **`game_players.account_id NULL`** — бот-слот без человека. Человеческий слот держит `account_id` даже после разрыва (для возврата по cookie, §9).
- **`game_players.disconnected_at`** — момент разрыва WS; `NULL`, пока игрок на связи (или это чистый бот). Используется для окна возврата `rejoinWindowSeconds`.
- **Владелец** — сидит в `slot 0`; `games.owner_account_id` дублирует для быстрых проверок прав (`start`, правка конфига).
- **Миграция v1→v2** — простое применение `schema.sql` поверх существующей БД: все `CREATE … IF NOT EXISTS` добавляют только новые таблицы/индексы, `PRAGMA user_version` фиксирует версию 2.

---

## 7. Проекция скрытой информации

Сервер хранит полное состояние (все руки, обе колоды). Каждому игроку шлётся **проекция** — то же состояние, где скрыто только по-настоящему закрытое.

**Что скрывается** (заменяется на `{ "hidden": true, "count": N }`):

1. `cars[].hand` — **чужие** руки (для всех машин, кроме собственной). Своя рука остаётся полным массивом `[{uid,type}, …]`.
2. `race.deck` — колода добора (порядок неизвестен).
3. `race.eventDeck` — колода событий Пустоши (порядок неизвестен).

**Что НЕ скрывается** (остаётся в проекции как есть — это открытая информация настольной игры):

- вся **трасса**: `race.track` (nodes, edges, ring, grid, checkpoints, pitNodes, fork, distFromStart/distToFinish, board, seed, count, label, mosaic);
- **все публичные поля машин** (`cars[]`), кроме `hand`: `id`, `factionId`, `name`, `carName`, `baseHp/maxHp/hp`, `slots`, `upgrades`, `scrap`, `cp`, `node`, `lapsDone`, `finished`, `finishPos`, `destroyed`, `downTurns`, `pit`, `burn`, `smoke`, `shield`, `emp`, `spawnProtect`, `lastMove`, `nextMoveBonus/nextMovePenalty`, `flags`, `racePos`, `raceStats`, `raceDamage/raceKills` и пр.;
- **жетоны на трассе** `race.tokens` (мины/масло/огонь/обломки) — они видимы на поле;
- **сброс** `race.discard` и `race.eventDiscard` — сыгранные карты/события лежат лицом вверх;
- **состояние хода** `race.round/turnIdx/currentId/order/phase/turn/finishOrder/firstFinishRound/roundEffect/stats/shop`, `over`, `results`;
- **журнал** `log` — все публичные события гонки;
- `version`, `mode`, `seed`, `laps`, `trackSize`, `trackKind`, `raceIndex`, `stage`, `options`.

> Итог: единственная закрытая информация — **содержимое чужих рук** и **порядок двух колод**. Всё остальное — публично и не должно скрываться.

---

## 8. Таймер хода

- **По умолчанию `turnTimerSeconds = 90`**. Значение берётся из `config.turnTimerSeconds`; `null` отключает таймер.
- Когда наступает ход человека, сервер шлёт `your_turn` (с `deadline`) и сразу `turn_timeout { slot, remainingMs }`.
- Пока ход активен и таймер включён, сервер периодически шлёт `turn_timeout` с обновлённым `remainingMs` (рекомендуется раз в 10 с и на последних 10 с).
- **При истечении** (`remainingMs ≤ 0`) сервер автоматически выполняет `end_turn` от имени слота (как будто игрок завершил ход), инкрементирует `seq` и рассылает новый `state`. Отдельного сообщения об истечении нет — оно выражается новым `state` (фаза сменилась).
- **Выбор маршрута (`route_choice`) использует тот же таймер хода.** Если таймер истёк, пока игрок не выбрал `choose_route`, сервер берёт **первый вариант** из `options`, завершает движение и заканчивает ход авто-`end_turn`.
- `turn_timeout` носит информационный характер и не отменяет таймер на стороне клиента; канон — сервер.

---

## 9. Выбывание и переподключение

- **Разрыв WS** (или явный `resign`) для человеческого слота:
  1. сервер помечает `game_players.controller = 'bot'`, `disconnected_at = now`;
  2. рассылает `opponent_left { slot, accountId, displayName, reason: 'disconnect'|'resign', controllerNow: 'bot' }`;
  3. движок продолжает вести машину ИИ (`CnA.aiTakeTurn`), таймер для этого слота отключается.
- **Возврат:** человек открывает `/ws` (та же cookie), шлёт `join_lobby { lobbyCode }`.
  - Если `now - disconnected_at ≤ rejoinWindowSeconds` (по умолчанию **300 с**): сервер возвращает `reconnect_ok { slot, seq, projection }`, ставит `controller='human'`, `disconnected_at=NULL`, рассылает `lobby_update`/`opponent_left` (обратно). Управление возвращается человеку со следующего его хода (текущий ход, если был передан ИИ, доигрывается).
  - Если окно истекло: сервер отвечает `error { code: 'rejoin_expired' }`; слот остаётся ботом. Игрок может смотреть партию (сервер шлёт проекции), но не управлять.
- **Сдача (`resign`)** обрабатывается как разрыв без окна возврата (или с тем же окном — настраивается; по умолчанию `resign` = окно тоже 300 с, но причина фиксируется как `resign`).
- Слот с `account_id IS NULL` (чистый бот) не участвует в механике возврата.

---

## 10. Финализация в `runs` (и лидерборды)

Когда игра завершается (`status → finished`):

1. Сервер формирует итоговые `standings` (та же форма, что и `computeStandings` фазы 1).
2. Для **каждого человеческого слота** (`game_players.account_id IS NOT NULL`, независимо от того, отвалился он или остался на связи) создаётся обычный `run`:
   - `mode = 'race'`, `status = 'finished'`;
   - `faction` = фракция слота, `track_kind/track_size/laps/seed` из `config_json`;
   - `score` = ОЧ игрока, `damage` = нанесённый урон, `kills` = уничтожения;
   - `result` = JSON `RunResult` (`score`, `detail {pos,finished,damage,kills,scrap}`, `standings`);
   - `started_at` = `games.started_at`, `finished_at` = момент финализации.
3. Эти `run` попадают в существующий лидерборд `mode='race'` (личный максимум по `score`) без изменений REST/клиента фазы 1.

Сервер рассылает `result { gameId, standings, runs:[{accountId, runId, score, detail}] }`, затем `lobby_update` со статусом `finished`.

---

## 11. `seq` и синхронизация

- `games.seq` — монотонный (0,1,2,…) счётчик версий состояния одной игры.
- Каждое сообщение `state` несёт свой `seq`.
- Клиент запоминает последний принятый `seq` и возвращает его в `ackSeq` следующего действия.
- **Рассинхрон:** если сервер видит `ackSeq < текущий seq` (клиент пропустил кадры) — сервер отвечает полной проекцией в ближайшем `state` (в фазе 2 v1 `state` всегда полный, поэтому догонка тривиальна).
- **Идемпотентность:** действие с `clientId` применяется один раз; повтор (например, после таймаута сети) возвращает текущий `state`, не дублируя эффект.
- После переподключения `reconnect_ok` всегда содержит текущий `seq` и полную `projection`.

---

## 12. Принятые решения и допущения

1. **Сервер авторитетен** (держит все руки/колоды); клиент получает только проекции. Это основа античита и возврата игроков.
2. **Единственная скрытая информация** — чужие руки и порядок двух колод. Всё остальное публично (§7).
3. **Слот 0 = владелец**; `games.owner_account_id` дублирует владельца для быстрых проверок.
4. **Пустые слоты = боты.** Старт возможен от 1 человека; остальные слоты — ИИ.
5. **Возврат 300 с** по умолчанию (`rejoinWindowSeconds`), после чего слот остаётся ботом.
6. **Таймер 90 с** по умолчанию, `turnTimerSeconds: null` отключает; истечение = авто-`end_turn`.
7. **Финализация** создаёт обычные `run` (`mode='race'`) для всех человеческих слотов → те же лидерборды фазы 1.
8. **Без дельт в v1** — сервер всегда шлёт полные проекции; `seq`/`ackSeq` дают детекцию рассинхрона и базу для дельт позже.

---

## 13. Контрольный список приёмки (для реализации)

- [ ] `server/schema.sql` применяется в чистую БД: таблицы `games`/`game_players` созданы, `PRAGMA user_version = 2`.
- [ ] Применение поверх существующей БД фазы 1 (v1) добавляет только новые таблицы/индексы, не ломая старые.
- [ ] `GET /ws` апгрейдит по cookie `cna_session`, проверяет `Origin`, шлёт `hello`.
- [ ] Все перечисленные WS-сообщения (клиентские и серверные) реализованы по §4.
- [ ] REST `/api/lobbies` (create/get/join/leave/start) реализован по §5; 4 слота, владелец, коды.
- [ ] Проекция скрывает чужие руки и обе колоды, не скрывая ничего из списка §7.
- [ ] Таймер 90 с (или из конфига) авто-`end_turn` при истечении; `turn_timeout` с остатком.
- [ ] Разрыв/`resign` → `controller=bot` + `opponent_left`; возврат по cookie в течение 300 с → `reconnect_ok`.
- [ ] По концу игры для каждого человеческого слота создан `run` (`mode='race'`, `status='finished'`) с `score/damage/kills/result`.
