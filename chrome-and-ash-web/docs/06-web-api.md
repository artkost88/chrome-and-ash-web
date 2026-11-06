# ХРОМ И ПЕПЕЛ — контракт web API, фаза 1

**Версия контракта:** 1.0
**Статус:** предложение (для реализации сервером фазы 1)
**Относится к:** `chrome-and-ash-web/` (клиент) и `server/` (бэкенд)
**Сопутствующие артефакты:**
- `server/schema.sql` — исполняемая схема SQLite (DDL);
- `server/api-schemas.json` — машиночитаемый пакет JSON Schema (тот же контракт, что и ниже).

Этот документ фиксирует договор между веб-клиентом и сервером для **фазы 1** (solo: заезд / чемпионат / ежедневный заезд, счёт и таблицы лидеров). Проектируется так, чтобы **фаза 2** (WebSocket / PvP) добавлялась новыми ресурсами и каналом, **не переписывая** уже написанный клиентский код для auth / профиля / сохранений / лидербордов.

---

## 1. Цели и границы

Фаза 1 делает сетевой одиночную игру, перенеся детерминированный движок `chrome-and-ash/js/engine.js` в веб-версию:

- регистрация / вход / выход (сессионная авторизация);
- профиль игрока и сводка статистики;
- ежедневный заезд (общий сид и условия на всех игроков);
- создание и история заездов (`runs`);
- сохранение / загрузка состояния партии (`saves`);
- глобальные таблицы лидеров.

Явно **вне фазы 1**: PvP, matchmaking, комнаты/лобби, живые ходы соперников, чат, друзья, покупки/монетизация. Их влияние на контракт учтено в разделе 8, но самих эндпоинтов фазы 1 они не меняют.

---

## 2. Принципы проектирования

1. **Непрозрачное состояние (opaque state).** Сервер хранит состояние игры как версионированный JSON-блоб и **не интерпретирует правила**. Всю игровую логику считает клиент (детерминированный движок). Сервер проверяет только *конверт* состояния (`schemaVersion`, `engineVersion`, `seed`, `mode`, `stage`) и авторизацию. Это снимает связанность клиента и сервера и делает фазу 2 добавлением канала доставки того же блоба.

2. **Сессии через cookie.** Токен сессии передаётся только в `HttpOnly`-cookie, никогда в JSON-теле. WebSocket-хендшейк в фазе 2 несёт те же cookie — клиенту не нужно дописывать передачу токена.

3. **Детерминизм и сид.** Движок воспроизводим по `seed`; `rng` в состояние **не сериализуется** (восстанавливается из `seed + raceIndex`). Это даёт базис для серверной валидации/повторов в фазе 2.

4. **Оптимистическая блокировка.** Каждое сохранение несёт монотонный `revision`; устаревший `revision` отклоняется (`409 CONFLICT`). Тот же механизм ляжет в основу синхронизации состояния в PvP.

5. **Стабильная поверхность.** Пути `POST /api/auth/*`, `/api/me`, `/api/daily`, `/api/runs`, `/api/leaderboard`, `/api/save/:id` фиксируются как контракт v1. Фаза 2 добавляет `/ws` и, при необходимости, новые ресурсы (`/api/lobbies` и т.п.) — существующие не меняются.

6. **Клиент считает результат.** Итоговый счёт и детали (место, урон, уничтожения) присылает клиент в терминальном сохранении (`status: "finished"`). Сервер не разбирает `engine`, а полагается на это поле — опять же для независимости от правил.

---

## 3. Модель данных

Сущности и связи:

```
accounts 1 ── * sessions
accounts 1 ── * runs
accounts 1 ── * saves
accounts 1 ── * daily_results
runs     1 ── * saves          (фаза 1 — ровно один слот slot=0)
runs     1 ── 0..1 daily_results (только для mode='daily', лучший результат за день)
```

| Сущность | Назначение | Ключевые поля |
|---|---|---|
| `account` | зарегистрированный игрок | username, password_hash, display_name |
| `session` | сессия авторизации | token_hash (токен только в cookie) |
| `run` | один проход (заезд / чемпионат / ежедневный) | mode, faction, seed, status, score |
| `save` | последний снимок состояния партии | run_id, revision, state (JSON) |
| `daily_result` | лучший результат игрока за календарный день | daily_date, score, damage, kills |

Терминология:

- **run** — неизменяемая по сути запись о проходе: создаётся один раз, затем `active → finished | abandoned`.
- **save** — изменяемый снимок: перезаписывается (`PUT`) с инкрементом `revision`.
- **daily** — детерминированное ежедневное испытание: общий сид/трасса/фракция на всех.

---

## 4. Общие соглашения

### 4.1. Базовый URL и версионирование

- Базовый префикс — `https://<host>/api` (пути строго как в контракте, без сегмента версии).
- Версия контракта фиксируется полем `engineVersion`/`schemaVersion` в состоянии и номером версии в этом документе. Breaking-изменения в будущем переводятся на `/api/v2`, не трогая `/api`.

### 4.2. Аутентификация

- Регистрация/вход возвращают аккаунт и выставляют cookie `cna_session=<token>`:
  - `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` (в проде по HTTPS), `Max-Age=2592000` (30 дней, настраивается).
- Токен — 32 случайных байта в base64url; в БД хранится только `sha256(token)`.
- Защищённые эндпоинты (все, кроме `register`/`login`/`leaderboard`) требуют валидную сессию, иначе `401`.
- CSRF: `SameSite=Lax` отсекает кросс-сайтовые POST; для WebSocket в фазе 2 добавится проверка `Origin` при апгрейде.

### 4.3. Идентификаторы и время

- Все id — **UUIDv7** (время-упорядоченные, индекс-дружелюбные).
- Время — UTC ISO 8601 с `Z` (`2026-10-24T09:00:00Z`).
- `daily_date` — календарная дата `YYYY-MM-DD` **в UTC** (одна дата на всех игроков).

### 4.4. Ошибки

Единый конверт ошибки:

```json
{ "error": { "code": "invalid_credentials", "message": "Неверное имя или пароль", "details": {} } }
```

| HTTP | Код приложения | Смысл |
|---|---|---|
| 400 | `invalid_request` | нарушена JSON-схема тела |
| 401 | `unauthorized` | нет/просрочена сессия |
| 401 | `invalid_credentials` | неверный логин/пароль |
| 403 | `forbidden` | чужой ресурс (`save`/`run` не твой) |
| 404 | `not_found` | нет такого ресурса |
| 409 | `username_taken` | имя занято |
| 409 | `stale_revision` | устаревший `revision` |
| 409 | `run_finalized` | run уже завершён |
| 422 | `invalid_enum` | недопустимое значение перечисления/режима |
| 422 | `weak_password` | пароль не проходит политику |
| 429 | `rate_limited` | превышен лимит запросов |
| 500 | `internal` | внутренняя ошибка |

### 4.5. Пагинация

- `GET /api/runs` — курсорная: `limit` (по умолч. 20, макс. 100), `before=<runId>`; ответ отдаёт `nextCursor`.
- `GET /api/leaderboard` — топ-N: `limit` (по умолч. 50, макс. 200), `offset`.

### 4.6. Лимиты защиты

- `state` не больше 256 КБ после сериализации (лог движка обрезан до 400 строк — фактически это единицы КБ).
- Регистрация/вход — rate limit на IP и на аккаунт.
- Пароли — scrypt (`N=16384, r=8, p=1`, PHC-строка `scrypt$…`); минимум 8 символов.

---

## 5. Типы данных (JSON Schema, `$defs`)

Ниже — компоненты, на которые ссылаются схемы эндпоинтов. Машиночитаемая копия всего пакета — `server/api-schemas.json`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://cna.example/api/v1/schemas.json",
  "$defs": {
    "Uuid": { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    "Username": { "type": "string", "minLength": 3, "maxLength": 32, "pattern": "^[A-Za-z0-9_.-]+$" },
    "Password": { "type": "string", "minLength": 8, "maxLength": 128 },
    "DisplayName": { "type": "string", "minLength": 1, "maxLength": 32 },
    "FactionId": { "type": "string", "enum": ["chrome", "rust", "carnival", "swarm"] },
    "Mode": { "type": "string", "enum": ["race", "championship", "daily"] },
    "TrackKind": { "type": "string", "enum": ["ring", "mosaic"] },
    "RunStatus": { "type": "string", "enum": ["active", "finished", "abandoned"] },
    "SaveStatus": { "type": "string", "enum": ["active", "finished"] },
    "Stage": { "type": "string", "enum": ["race", "results", "shop", "final"] },
    "IsoDate": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "Timestamp": { "type": "string", "format": "date-time" },

    "Account": {
      "type": "object",
      "required": ["id", "username", "displayName", "factionPref", "createdAt"],
      "properties": {
        "id": { "$ref": "#/$defs/Uuid" },
        "username": { "$ref": "#/$defs/Username" },
        "displayName": { "$ref": "#/$defs/DisplayName" },
        "factionPref": { "anyOf": [ { "$ref": "#/$defs/FactionId" }, { "type": "null" } ] },
        "createdAt": { "$ref": "#/$defs/Timestamp" }
      },
      "additionalProperties": false
    },

    "AccountStats": {
      "type": "object",
      "required": ["runsTotal", "runsFinished", "raceBest", "championshipBest", "dailyBest"],
      "properties": {
        "runsTotal": { "type": "integer", "minimum": 0 },
        "runsFinished": { "type": "integer", "minimum": 0 },
        "raceBest": { "type": ["integer", "null"] },
        "championshipBest": { "type": ["integer", "null"] },
        "dailyBest": { "type": ["integer", "null"] }
      },
      "additionalProperties": false
    },

    "ResultDetail": {
      "type": "object",
      "required": ["pos", "finished", "damage", "kills", "scrap"],
      "properties": {
        "pos": { "type": "integer", "minimum": 1, "maximum": 4 },
        "finished": { "type": "boolean" },
        "damage": { "type": "integer", "minimum": 0 },
        "kills": { "type": "integer", "minimum": 0 },
        "scrap": { "type": "integer", "minimum": 0 }
      },
      "additionalProperties": false
    },

    "StandingRow": {
      "type": "object",
      "required": ["place", "faction", "name", "cp", "damage", "kills", "scrap", "human"],
      "properties": {
        "place": { "type": "integer", "minimum": 1 },
        "faction": { "$ref": "#/$defs/FactionId" },
        "name": { "type": "string" },
        "cp": { "type": "integer" },
        "damage": { "type": "integer" },
        "kills": { "type": "integer" },
        "scrap": { "type": "integer" },
        "human": { "type": "boolean" }
      },
      "additionalProperties": false
    },

    "RunResult": {
      "type": "object",
      "required": ["score", "detail"],
      "properties": {
        "score": { "type": "integer", "minimum": 0 },
        "detail": { "$ref": "#/$defs/ResultDetail" },
        "standings": { "type": "array", "items": { "$ref": "#/$defs/StandingRow" } }
      },
      "additionalProperties": false
    },

    "Run": {
      "type": "object",
      "required": ["id", "accountId", "mode", "faction", "trackKind", "trackSize", "laps", "seed", "status", "startedAt"],
      "properties": {
        "id": { "$ref": "#/$defs/Uuid" },
        "accountId": { "$ref": "#/$defs/Uuid" },
        "mode": { "$ref": "#/$defs/Mode" },
        "dailyDate": { "anyOf": [ { "$ref": "#/$defs/IsoDate" }, { "type": "null" } ] },
        "faction": { "$ref": "#/$defs/FactionId" },
        "trackKind": { "$ref": "#/$defs/TrackKind" },
        "trackSize": { "type": "integer", "minimum": 24, "maximum": 36 },
        "laps": { "type": "integer", "enum": [1, 2] },
        "seed": { "type": "integer", "minimum": 0 },
        "status": { "$ref": "#/$defs/RunStatus" },
        "score": { "type": ["integer", "null"] },
        "damage": { "type": ["integer", "null"] },
        "kills": { "type": ["integer", "null"] },
        "result": { "anyOf": [ { "$ref": "#/$defs/RunResult" }, { "type": "null" } ] },
        "startedAt": { "$ref": "#/$defs/Timestamp" },
        "finishedAt": { "anyOf": [ { "$ref": "#/$defs/Timestamp" }, { "type": "null" } ] }
      },
      "additionalProperties": false
    },

    "SaveRef": {
      "type": "object",
      "required": ["id", "runId", "revision", "status", "updatedAt"],
      "properties": {
        "id": { "$ref": "#/$defs/Uuid" },
        "runId": { "$ref": "#/$defs/Uuid" },
        "revision": { "type": "integer", "minimum": 0 },
        "status": { "$ref": "#/$defs/SaveStatus" },
        "updatedAt": { "$ref": "#/$defs/Timestamp" }
      },
      "additionalProperties": false
    },

    "Save": {
      "allOf": [
        { "$ref": "#/$defs/SaveRef" },
        {
          "type": "object",
          "required": ["state"],
          "properties": { "state": { "$ref": "#/$defs/SaveState" } },
          "additionalProperties": false
        }
      ]
    },

    "SaveState": {
      "type": "object",
      "required": ["schemaVersion", "engineVersion", "seed", "mode", "raceIndex", "stage", "nextUid", "savedAt", "engine"],
      "properties": {
        "schemaVersion": { "const": 1 },
        "engineVersion": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
        "seed": { "type": "integer", "minimum": 0 },
        "mode": { "$ref": "#/$defs/Mode" },
        "raceIndex": { "type": "integer", "minimum": 0 },
        "stage": { "$ref": "#/$defs/Stage" },
        "nextUid": { "type": "integer", "minimum": 1 },
        "savedAt": { "$ref": "#/$defs/Timestamp" },
        "engine": { "type": "object" }
      },
      "additionalProperties": false
    },

    "DailyChallenge": {
      "type": "object",
      "required": ["mode", "seed", "faction", "trackKind", "trackSize", "laps"],
      "properties": {
        "mode": { "const": "daily" },
        "seed": { "type": "integer", "minimum": 0 },
        "faction": { "$ref": "#/$defs/FactionId" },
        "trackKind": { "$ref": "#/$defs/TrackKind" },
        "trackSize": { "type": "integer", "minimum": 24, "maximum": 36 },
        "laps": { "type": "integer", "enum": [1, 2] }
      },
      "additionalProperties": false
    },

    "DailyMyBest": {
      "type": "object",
      "required": ["score", "runId", "detail", "updatedAt"],
      "properties": {
        "score": { "type": "integer", "minimum": 0 },
        "runId": { "$ref": "#/$defs/Uuid" },
        "detail": { "$ref": "#/$defs/ResultDetail" },
        "updatedAt": { "$ref": "#/$defs/Timestamp" }
      },
      "additionalProperties": false
    },

    "LeaderboardRow": {
      "type": "object",
      "required": ["rank", "accountId", "displayName", "faction", "score", "detail", "runId", "at"],
      "properties": {
        "rank": { "type": "integer", "minimum": 1 },
        "accountId": { "$ref": "#/$defs/Uuid" },
        "displayName": { "$ref": "#/$defs/DisplayName" },
        "faction": { "$ref": "#/$defs/FactionId" },
        "score": { "type": "integer", "minimum": 0 },
        "detail": { "$ref": "#/$defs/ResultDetail" },
        "runId": { "$ref": "#/$defs/Uuid" },
        "at": { "$ref": "#/$defs/Timestamp" }
      },
      "additionalProperties": false
    },

    "ErrorBody": {
      "type": "object",
      "required": ["error"],
      "properties": {
        "error": {
          "type": "object",
          "required": ["code", "message"],
          "properties": {
            "code": { "type": "string" },
            "message": { "type": "string" },
            "details": { "type": "object" }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  }
}
```

### 5.1. Семантика `SaveState` и правила сериализации

`SaveState` — это конверт поверх сериализуемого среза игрового состояния движка. Поля конверта сервер **валидирует**; `engine` сервер хранит и отдаёт как непрозрачный объект.

`engine` = объект `game` движка `CnA.createGame(...)` за вычетом несериализуемых/транзиентных полей:

| Поле `engine` | Тип | Примечание |
|---|---|---|
| `version` | string | версия движка (`CnA.VERSION`) |
| `mode`, `seed`, `laps`, `trackSize`, `trackKind`, `raceIndex`, `stage` | — | дублируются в конверт для быстрой валидации |
| `cars` | array | 4 машины: корпус, рука, улучшения, лом, ОЧ, позиции |
| `race` | object | трасса, колоды, жетоны, порядок хода, текущий ход |
| `log` | array | до 400 строк журнала |
| `shop` | array | витрина мастерской |
| `results` | object \| null | результат последней гонки |
| `finalStandings` | array \| null | итог чемпионата |
| `options` | object | параметры партии |

**Не сериализуются:**

- `rng` — функция; восстанавливается детерминированно: `CnA.mulberry32(seed + raceIndex * 1013 + 7)` (см. `setupRace` в движке);
- `quiet` — транзиентный флаг вывода.

**`nextUid`** — в движке счётчик uid карт глобальный для модуля (`CnA.nextUid`). Чтобы после восстановления новые карты не получили uid, совпадающий с уже лежащими в руках, клиентский (де)сериализатор обязан сохранить/восстановить значение счётчика. Поэтому оно вынесено в конверт.

Псевдокод клиентского помощника:

```js
function toSaveState(game) {
  const { rng, quiet, ...engine } = game;
  return {
    schemaVersion: 1,
    engineVersion: CnA.VERSION,
    seed: game.seed,
    mode: game.mode,
    raceIndex: game.raceIndex,
    stage: game.stage,
    nextUid: CnA.nextUid(),      // или значение, взятое из замыкания
    savedAt: new Date().toISOString(),
    engine,
  };
}

function fromSaveState(s) {
  const game = s.engine;
  game.rng = CnA.mulberry32(s.seed + s.raceIndex * 1013 + 7);
  CnA.setUidCounter(s.nextUid);  // см. примечание выше
  return game;
}
```

---

## 6. Эндпоинты

Сводная таблица:

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| POST | `/api/auth/register` | нет | создать аккаунт |
| POST | `/api/auth/login` | нет | войти |
| POST | `/api/auth/logout` | да | выйти |
| GET | `/api/me` | да | профиль + статистика + активная партия |
| GET | `/api/daily` | да | сегодняшний ежедневный заезд + мой лучший + топ |
| GET | `/api/runs` | да | история моих заездов |
| POST | `/api/runs` | да | начать заезд |
| GET | `/api/save/:id` | да | загрузить снимок |
| PUT | `/api/save/:id` | да | сохранить/финализировать снимок |
| DELETE | `/api/save/:id` | да | бросить заезд |
| GET | `/api/leaderboard` | нет | таблица лидеров |

> `GET /api/leaderboard` публичный (не требует сессии) — это позволяет показывать топ на странице входа. Если политика изменится, достаточно добавить требование сессии; путь и схема ответа не меняются.

---

### 6.1. `POST /api/auth/register`

Создаёт аккаунт и сразу открывает сессию (cookie `cna_session`).

**Запрос** (`application/json`):

```json
{
  "type": "object",
  "required": ["username", "password"],
  "properties": {
    "username": { "$ref": "#/$defs/Username" },
    "password": { "$ref": "#/$defs/Password" },
    "displayName": { "$ref": "#/$defs/DisplayName" }
  },
  "additionalProperties": false
}
```

**Ответ `201 Created`:**

```json
{
  "type": "object",
  "required": ["account", "sessionExpiresAt"],
  "properties": {
    "account": { "$ref": "#/$defs/Account" },
    "sessionExpiresAt": { "$ref": "#/$defs/Timestamp" }
  },
  "additionalProperties": false
}
```

Пример тела ответа:

```json
{
  "account": {
    "id": "0194f2c0-0000-7a00-9b00-000000000001",
    "username": "wastelander",
    "displayName": "Водила",
    "factionPref": null,
    "createdAt": "2026-10-24T09:00:00Z"
  },
  "sessionExpiresAt": "2026-11-23T09:00:00Z"
}
```

Ошибки: `409 username_taken`, `422 weak_password`, `429 rate_limited`.

---

### 6.2. `POST /api/auth/login`

**Запрос:**

```json
{
  "type": "object",
  "required": ["username", "password"],
  "properties": {
    "username": { "$ref": "#/$defs/Username" },
    "password": { "$ref": "#/$defs/Password" }
  },
  "additionalProperties": false
}
```

**Ответ `200 OK`:** как `register` (`account` + `sessionExpiresAt`), плюс `Set-Cookie`.

Ошибки: `401 invalid_credentials`, `429 rate_limited`.

---

### 6.3. `POST /api/auth/logout`

Без тела. Отзывает текущую сессию и очищает cookie.

**Ответ `204 No Content`.**

Ошибки: `401 unauthorized`.

---

### 6.4. `GET /api/me`

**Ответ `200 OK`:**

```json
{
  "type": "object",
  "required": ["account", "stats"],
  "properties": {
    "account": { "$ref": "#/$defs/Account" },
    "stats": { "$ref": "#/$defs/AccountStats" },
    "activeRun": { "anyOf": [ { "$ref": "#/$defs/Run" }, { "type": "null" } ] },
    "activeSave": { "anyOf": [ { "$ref": "#/$defs/SaveRef" }, { "type": "null" } ] }
  },
  "additionalProperties": false
}
```

- `activeRun` — последний `run` со статусом `active` (или `null`).
- `activeSave` — указатель (`SaveRef`, без `state`) на последний снимок этого run, чтобы клиент мог дозагрузить его через `GET /api/save/:id`.

Пример:

```json
{
  "account": { "id": "0194f2c0-0000-7a00-9b00-000000000001", "username": "wastelander", "displayName": "Водила", "factionPref": "rust", "createdAt": "2026-10-24T09:00:00Z" },
  "stats": { "runsTotal": 12, "runsFinished": 9, "raceBest": 16, "championshipBest": 41, "dailyBest": 18 },
  "activeRun": null,
  "activeSave": null
}
```

Ошибки: `401 unauthorized`.

---

### 6.5. `GET /api/daily`

Отдаёт сегодняшний ежедневный заезд (детерминированный по дате), мой лучший результат и топ-N дня.

**Правило генерации daily** (на сервере, без таблицы конфигурации):

- `date = сегодняшняя UTC-дата (YYYY-MM-DD)`;
- `seed = (sha256("cna:daily:" + date) — первые 4 байта как big-endian uint32) >>> 1` — детерминированный 31-битный неотрицательный сид от даты;
- `faction = [chrome, rust, carnival, swarm][dayIndex % 4]`, где `dayIndex` — дней от эпохи;
- `trackKind = "mosaic"`, `trackSize = 36`, `laps = 1`.

Одинаковые условия у всех игроков — поэтому в ежедневном заезде фракция/сид/трасса **не выбираются** игроком.

**Ответ `200 OK`:**

```json
{
  "type": "object",
  "required": ["date", "challenge", "myBest", "board"],
  "properties": {
    "date": { "$ref": "#/$defs/IsoDate" },
    "challenge": { "$ref": "#/$defs/DailyChallenge" },
    "myBest": { "anyOf": [ { "$ref": "#/$defs/DailyMyBest" }, { "type": "null" } ] },
    "board": { "type": "array", "items": { "$ref": "#/$defs/LeaderboardRow" } }
  },
  "additionalProperties": false
}
```

`board` — топ-N за `date` (N = query `limit`, по умолч. 50). Ошибки: `401 unauthorized`.

---

### 6.6. `POST /api/runs`

Начинает новый заезд и сразу создаёт слот сохранения.

**Запрос:**

```json
{
  "type": "object",
  "required": ["mode", "faction"],
  "properties": {
    "mode": { "$ref": "#/$defs/Mode" },
    "faction": { "$ref": "#/$defs/FactionId" },
    "trackKind": { "$ref": "#/$defs/TrackKind" },
    "trackSize": { "type": "integer", "minimum": 24, "maximum": 36 },
    "laps": { "type": "integer", "enum": [1, 2] },
    "seed": { "type": "integer", "minimum": 0 },
    "dailyDate": { "$ref": "#/$defs/IsoDate" }
  },
  "additionalProperties": false
}
```

Правила валидации:

- `mode="daily"` → `faction`/`trackKind`/`trackSize`/`laps`/`seed`/`dailyDate` берутся из ежедневного вызова (`GET /api/daily`); присланные значения игнорируются (либо отклоняются, если конфликтуют) — клиент должен подставить challenge.
- `mode!="daily"` → `dailyDate` запрещён; `seed` при отсутствии генерируется сервером случайно.
- Умолчания: `trackKind="mosaic"`, `trackSize=36` (mosaic) / `28` (ring), `laps=1`.
- Если у игрока уже есть `active` run — он автоматически помечается `abandoned` (нельзя вести две партии одновременно).

**Ответ `201 Created`:**

```json
{
  "type": "object",
  "required": ["run", "save"],
  "properties": {
    "run": { "$ref": "#/$defs/Run" },
    "save": { "$ref": "#/$defs/SaveRef" }
  },
  "additionalProperties": false
}
```

`save` — пустой слот (`revision: 0`, `status: "active"`, без `state`); клиент пишет в него через `PUT /api/save/:id`.

Пример:

```json
{
  "run": {
    "id": "0194f2c0-0000-7a00-9b00-000000000002",
    "accountId": "0194f2c0-0000-7a00-9b00-000000000001",
    "mode": "daily",
    "dailyDate": "2026-10-24",
    "faction": "chrome",
    "trackKind": "mosaic",
    "trackSize": 36,
    "laps": 1,
    "seed": 18273645,
    "status": "active",
    "score": null,
    "damage": null,
    "kills": null,
    "result": null,
    "startedAt": "2026-10-24T09:00:00Z",
    "finishedAt": null
  },
  "save": {
    "id": "0194f2c0-0000-7a00-9b00-000000000003",
    "runId": "0194f2c0-0000-7a00-9b00-000000000002",
    "revision": 0,
    "status": "active",
    "updatedAt": "2026-10-24T09:00:00Z"
  }
}
```

Ошибки: `401 unauthorized`, `422 invalid_enum`.

---

### 6.7. `GET /api/runs`

История моих заездов, курсорная пагинация.

**Query:** `limit` (20), `before` (runId), `mode`, `status`.

**Ответ `200 OK`:**

```json
{
  "type": "object",
  "required": ["runs", "nextCursor"],
  "properties": {
    "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } },
    "nextCursor": { "anyOf": [ { "$ref": "#/$defs/Uuid" }, { "type": "null" } ] }
  },
  "additionalProperties": false
}
```

> В списке поле `result` опускается (тяжёлое); `score`/`damage`/`kills` присутствуют. Полный итог клиент и так знает локально, а в истории он не нужен.

Ошибки: `401 unauthorized`.

---

### 6.8. `GET /api/save/:id`

**Ответ `200 OK`:**

```json
{
  "type": "object",
  "required": ["save"],
  "properties": { "save": { "$ref": "#/$defs/Save" } },
  "additionalProperties": false
}
```

Возвращает полный `Save` (`SaveRef` + `state`). Ошибки: `401 unauthorized`, `403 forbidden` (чужой save), `404 not_found`.

---

### 6.9. `PUT /api/save/:id`

Сохранение снимка. Идемпотентно через `revision`.

**Запрос:**

```json
{
  "type": "object",
  "required": ["revision", "state"],
  "properties": {
    "revision": { "type": "integer", "minimum": 0 },
    "state": { "$ref": "#/$defs/SaveState" },
    "status": { "$ref": "#/$defs/SaveStatus" },
    "result": { "$ref": "#/$defs/RunResult" }
  },
  "additionalProperties": false
}
```

Правила:

- `revision` обязан равняться текущему `revision` сохранения; иначе `409 stale_revision`. После успеха сервер инкрементирует и возвращает новый `revision`.
- `status` по умолчанию `active`. Если `status="finished"`:
  - обязателен `result`;
  - сервер проверяет `state.stage ∈ {results, final}` (иначе `422`), сверяет `state.mode`/`state.seed` с run (иначе `422`) и лимит `state` ≤ 256 КБ (иначе `400`);
  - сервер финализирует run (`status="finished"`, `score/damage/kills/result`, `finishedAt`), записывает `daily_results` (для `mode="daily"` — с удержанием лучшего по `pos` → `damage`);
  - если daily-результат хуже уже сохранённого, сервер всё равно финализирует run и сохранение (revision инкрементируется), но НЕ обновляет `daily_results`, и возвращает `200` с `notImproved: true`.

**Ответ `200 OK`:**

```json
{
  "type": "object",
  "required": ["saved", "revision", "finalized", "run"],
  "properties": {
    "saved": { "const": true },
    "revision": { "type": "integer", "minimum": 0 },
    "finalized": { "type": "boolean" },
    "score": { "type": ["integer", "null"] },
    "notImproved": { "type": "boolean" },
    "run": {
      "type": "object",
      "required": ["id", "status"],
      "properties": {
        "id": { "$ref": "#/$defs/Uuid" },
        "status": { "$ref": "#/$defs/RunStatus" },
        "score": { "type": ["integer", "null"] },
        "finishedAt": { "anyOf": [ { "$ref": "#/$defs/Timestamp" }, { "type": "null" } ] }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

Пример финального ответа:

```json
{ "saved": true, "revision": 7, "finalized": true, "score": 18, "notImproved": false,
  "run": { "id": "0194f2c0-0000-7a00-9b00-000000000002", "status": "finished", "score": 18, "finishedAt": "2026-10-24T09:12:00Z" } }
```

Ошибки: `401 unauthorized`, `403 forbidden`, `404 not_found`, `409 stale_revision`, `409 run_finalized`, `422 invalid_request`.

---

### 6.10. `DELETE /api/save/:id`

Бросает незавершённый заезд: run → `abandoned`. Для уже `finished` — `409 run_finalized`.

**Ответ `204 No Content`.** Ошибки: `401 unauthorized`, `403 forbidden`, `404 not_found`, `409 run_finalized`.

---

### 6.11. `GET /api/leaderboard`

**Query:**

| Параметр | Значения | По умолч. |
|---|---|---|
| `mode` | `daily` \| `race` \| `championship` | `daily` |
| `date` | `YYYY-MM-DD` (только для `daily`) | сегодня (UTC) |
| `limit` | 1..200 | 50 |
| `offset` | 0..N | 0 |
| `scope` | `global` (фаза 1; зарезервировано `faction`/`friends` для фазы 2) | `global` |

**Сортировка:** для `daily` — `pos ASC`, `damage DESC`, `finished_at ASC` (ниже место — выше в таблице); для `race`/`championship` — `score DESC`, `damage DESC`, `finished_at ASC` (раньше — выше при полном равенстве).

- `daily` → читает `daily_results` за `date` (лучший по позиции результат каждого игрока).
- `race` / `championship` → читает `runs` (`status='finished'`), беря **лучший** `score` на игрока.

**Ответ `200 OK`:**

```json
{
  "type": "object",
  "required": ["mode", "date", "rows"],
  "properties": {
    "mode": { "$ref": "#/$defs/Mode" },
    "date": { "anyOf": [ { "$ref": "#/$defs/IsoDate" }, { "type": "null" } ] },
    "rows": { "type": "array", "items": { "$ref": "#/$defs/LeaderboardRow" } }
  },
  "additionalProperties": false
}
```

`date` — только для `mode="daily"`, иначе `null`. Пример строки:

```json
{ "rank": 1, "accountId": "0194f2c0-0000-7a00-9b00-000000000001", "displayName": "Водила",
  "faction": "chrome", "score": 18, "detail": { "pos": 1, "finished": true, "damage": 8, "kills": 2, "scrap": 10 },
  "runId": "0194f2c0-0000-7a00-9b00-000000000002", "at": "2026-10-24T09:12:00Z" }
```

Ошибки: `422 invalid_enum`.

---

## 7. Схема SQLite

Полный DDL — в `server/schema.sql`. Ниже — канонический вид с пояснениями.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;   -- версия схемы, использовать для миграций

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,            -- UUIDv7
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,               -- scrypt$N$r$p$salt$hash
  display_name  TEXT NOT NULL,
  faction_pref  TEXT,                        -- chrome|rust|carnival|swarm, NULL = не выбран
  created_at    TEXT NOT NULL,               -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,               -- UUIDv7 (не сам токен)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,           -- sha256(token); токен только в cookie
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,              -- UUIDv7
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('race','championship','daily')),
  daily_date  TEXT,                          -- YYYY-MM-DD, только для mode='daily'
  faction     TEXT NOT NULL CHECK (faction IN ('chrome','rust','carnival','swarm')),
  track_kind  TEXT NOT NULL DEFAULT 'mosaic' CHECK (track_kind IN ('ring','mosaic')),
  track_size  INTEGER NOT NULL DEFAULT 28,
  laps        INTEGER NOT NULL DEFAULT 1 CHECK (laps IN (1,2)),
  seed        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','abandoned')),
  score       INTEGER,                       -- ОЧ игрока; NULL пока активен
  damage      INTEGER,                       -- денормализация для сортировки лидерборда
  kills       INTEGER,                       -- денормализация для сортировки лидерборда
  result      TEXT,                          -- JSON RunResult (включая standings)
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((mode = 'daily') = (daily_date IS NOT NULL))
);
CREATE INDEX idx_runs_account ON runs(account_id, started_at DESC);
CREATE INDEX idx_runs_board ON runs(mode, status, score DESC, damage DESC, finished_at ASC);

CREATE TABLE saves (
  id         TEXT PRIMARY KEY,               -- UUIDv7
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slot       INTEGER NOT NULL DEFAULT 0,     -- фаза 1: один слот; фаза 2: несколько
  revision   INTEGER NOT NULL DEFAULT 0,     -- монотонная версия (оптимистичная блокировка)
  state      TEXT,                            -- JSON SaveState; NULL до первого сохранения
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, slot)
);
CREATE INDEX idx_saves_account ON saves(account_id);

CREATE TABLE daily_results (
  id          TEXT PRIMARY KEY,              -- UUIDv7
  daily_date  TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  faction     TEXT NOT NULL,
  pos         INTEGER NOT NULL,              -- место в гонке (1..4); меньше = лучше
  score       INTEGER NOT NULL,
  damage      INTEGER NOT NULL DEFAULT 0,
  kills       INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT NOT NULL,                 -- время принятия результата (тай-брейк)
  detail      TEXT,                          -- JSON ResultDetail
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (account_id, daily_date)            -- лучший результат игрока за день
);
CREATE INDEX idx_daily_board ON daily_results(daily_date, pos ASC, damage DESC, finished_at ASC);
CREATE INDEX idx_daily_account ON daily_results(account_id, daily_date);
```

Пояснения:

- **UUIDv7** — время-упорядоченный первичный ключ: ускоряет вставку в B-tree и даёт готовый курсор для `GET /api/runs` (`before=<id>`).
- **`token_hash`** — в БД никогда не хранится сырой токен; cookie хранит сырой токен, сервер ищет по `sha256`.
- **Денормализация `score/damage/kills`** в `runs` и `daily_results` — чтобы лидерборд сортировался обычными индексами, без `json_extract`.
- **`saves.slot`** — фаза 1 использует только `slot=0` (одно сохранение на run). В фазе 2 (несколько слотов) уникальность `(run_id, slot)` уже готова, и эндпоинт `/api/save/:id` не меняется.
- **`runs` vs `daily_results`** — `runs` хранит каждый проход; `daily_results` хранит *лучший* результат игрока за день (для ежедневного лидерборда).
- **`ON DELETE CASCADE`** — удаление аккаунта чистит сессии/заезды/сохранения/дневные результаты.

---

## 8. Готовность к фазе 2 (WebSocket / PvP)

Фаза 2 добавляет живую игру и PvP. Контракт фазы 1 спроектирован так, чтобы это было **добавлением**, а не переписыванием клиента.

1. **Канал поверх существующего состояния.** `/ws` (WebSocket) в фазе 2 переносит тот же `SaveState`/`engine`-блоб, что и `PUT /api/save/:id`. Клиентские функции `toSaveState`/`fromSaveState` переиспользуются без изменений. Плюс — служебные сообщения (`hello`, `join`, `sync`, `input`, `leave`), которые являются новым типом конверта, а не изменением REST.

2. **Авторизация без переписывания.** Cookie `cna_session` участвует в WebSocket-хендшейке. Клиенту не нужно добавлять заголовок `Authorization` или параметр токена. Сервер дополнительно проверяет `Origin` при апгрейде.

3. **Тот же примитив версионирования.** `revision` (оптимистичная блокировка) в PvP становится монотонным `seq` кадра синхронизации. Семантика «устаревшее состояние отклоняется» сохраняется; клиентский код работы с `revision` уже написан.

4. **UUID и id ресурсов.** Комнаты/лобби в фазе 2 — новые таблицы (`games`, `game_players`) со ссылками на `accounts` и (для учёта статистики) на `runs`. Путь `/api/leaderboard` и структура `LeaderboardRow` не меняются: PvP-заезд финализируется в обычный `run`, попадая в те же лидерборды.

5. **Детерминизм как основа античита.** Сид-детерминированный движок позволяет серверу в фазе 2 проверять/переигрывать ходы. Поле `seed` уже в конверте `SaveState` — для этого ничего менять не нужно.

6. **Стабильная REST-поверхность.** Эндпоинты auth/профиля/сохранений/лидербордов остаются. PvP добавляет `/ws` и, при необходимости, `POST/GET /api/lobbies` — как новые пути.

Что **намеренно отложено** и появится только в фазе 2 (не закладывается в схему фазы 1): серверный игровой цикл (server-authoritative), matchmaking, комнаты, чат, друзья, рейтинг Elo, спектаторы.

---

## 9. Принятые решения и допущения

1. **Единая метрика `score` = очки чемпионата (ОЧ) игрока.** Для `race`/`daily` — ОЧ, набранные в заезде (позиция + уничтожения + круги лидером); для `championship` — итоговая сумма ОЧ. Тай-брейк — `damage`, затем время (`finished_at`); для `daily` первичен `pos` (место в гонке, меньше — лучше).

2. **Ежедневный заезд фиксирует условия полностью** (сид, трасса, круги, фракция) — честное сравнение. Фракция ротируется по дате детерминированно.

3. **Один активный run на аккаунт.** Старый активный помечается `abandoned` при старте нового.

4. **Daily = лучший результат за день по позиции.** Повторные попытки разрешены; в `daily_results` хранится лучший результат по `pos` (меньше — лучше; тай-брейк `damage` → `finished_at`). Если новый результат хуже — run всё равно финализируется, `daily_results` не обновляется, ответ `200` с `notImproved: true`.

5. **`GET /api/leaderboard` публичный.** При необходимости легко ужесточить до авторизованного, не меняя форму ответа.

6. **Ошибки валидации на границе.** Схемы ниже трактуются как строгие (`additionalProperties: false`): лишние поля → `400 invalid_request`.

---

## 10. Контрольный список приёмки (для реализации)

- [ ] `server/schema.sql` применяется в пустую БД без ошибок; `PRAGMA user_version = 1`.
- [ ] `server/api-schemas.json` валиден как JSON и проходит `JSON.parse`/валидатор draft-2020-12.
- [ ] Каждый эндпоинт из таблицы раздела 6 реализован с заявленными кодами и формой тела.
- [ ] Сессия — только cookie; сырой токен в БД и JSON не появляется.
- [ ] `PUT /api/save/:id` отклоняет устаревший `revision` (`409`) и чужой save (`403`).
- [ ] Терминальное сохранение пишет `runs.score/damage/kills/result` и, для daily, `daily_results` с удержанием максимума.
- [ ] `GET /api/leaderboard` для `daily` читает `daily_results`, для `race/championship` — личный максимум из `runs`.
