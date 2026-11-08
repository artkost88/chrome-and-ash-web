# ХРОМ И ПЕПЕЛ — локальный запуск (web + PvP, фазы 1+2)

Сервер фаз 1+2: Node.js 24 + Express + WebSocket (`ws`) + встроенный `node:sqlite`
(без нативных зависимостей). Один процесс поднимает REST API, PvP-лобби/игру по
WebSocket и статический веб-клиент (`chrome-and-ash-web/`) на одном origin — без
публичного хостинга.

## Требования

- **Node.js ≥ 24.0.0** (нужен встроенный `node:sqlite` и `process.loadEnvFile`).
  Проверка: `node --version`.
- Зависимости: `express` и `ws` (WebSocket) — оба чистый JS, нативная компиляция не нужна.
- PvP-сервер грузит движок CnA из `chrome-and-ash-web/js/` (путь настраивается `ENGINE_DIR`).
- Windows / macOS / Linux.

## Быстрый старт (одна команда)

```bash
cd server
npm install        # только первый раз
npm start          # поднимает игру на http://127.0.0.1:3000
```

Откройте **http://127.0.0.1:3000** — загрузится веб-клиент. База данных создаётся
и инициализируется автоматически при первом запуске (файл `server/cna.db`).

> «Одна команда» = `npm start`. После первого `npm install` для каждого следующего
> запуска достаточно `npm start` — сервер + статика + БД.

## PvP (фаза 2): лобби и игра по WebSocket

PvP работает поверх того же сервера. Для игры нужны два аккаунта — например, откройте
клиент в двух браузерах/профилях и зарегистрируйте двух разных пользователей.

1. После входа в веб-клиенте нажмите **«PvP»** в соло-лобби.
2. **Создающий** игрок: выберите таймер хода (90 / 60 / 120 с / выкл) и нажмите
   **«Создать лобби»** — появится 6-символьный код (base32) и слот 0 «владелец (вы)».
3. **Второй** игрок: введите код и нажмите **«Войти»** — займёт слот 1; оба видят
   обновление лобби (`lobby_update`). Свободные слоты (2–3) доукомплектуются ботами
   при старте.
4. Владелец жмёт **«Старт»** — все участники получают `game_start` + состояние доски.
   Своя рука видна, чужие — только «КАРТ N»; доска, машины, трасса и жетоны общие
   (проекция скрывает только чужие руки и обе колоды).
5. На своём ходу показывается «ВАШ ХОД» + отсчёт таймера. Карты/цели → `play_card`,
   бросок d4 → `roll`, «завершить ход» → `end_turn`; авторитетен сервер.
6. **«Сдаться»** (`resign`) или разрыв соединения переводит слот под управление бота
   (`controller=bot`, сообщение `opponent_left`), игра продолжается. Пока не истекло
   окно возврата (`rejoinWindowSeconds`, по умолчанию 300 с), игрок может
   переподключиться тем же аккаунтом и вернуть управление (`reconnect_ok`); после —
   `rejoin_expired`.
7. По завершении гонки результат записывается в `runs` (mode=race) — участники
   попадают в лидерборд race (`/api/leaderboard?mode=race`).

Таймер и окно возврата — параметры **лобби** (`config`), а не переменные окружения:
`turnTimerSeconds` (по умолчанию 90; `null` = без таймера) и `rejoinWindowSeconds`
(по умолчанию 300). Истечение таймера вызывает авто-`end_turn` и шлётся `turn_timeout`.

Полный wire-контракт: `server/docs/07-pvp-protocol.md`.

## Инициализация БД

БД инициализируется автоматически при `npm start` и при `npm run db:init`
(схема `schema.sql` применяется идемпотентно — `CREATE ... IF NOT EXISTS`,
повторный запуск по существующей БД безопасен, данные сохраняются между перезапусками).

```bash
npm run db:init    # явно создать/проверить server/cna.db (можно пропустить)
```

Путь к БД задаётся переменной `DB_PATH` (по умолчанию `./cna.db` относительно `server/`).
Для тестов можно указать `DB_PATH=:memory:` (данные исчезнут при остановке).

Таблицы (схема `schema.sql` = базовая v2, миграция в v3 — `src/db.js`, `user_version = 3`):
`accounts`, `sessions`, `runs`, `saves`, `daily_results` (фаза 1), PvP — `games` /
`game_players` (фаза 2), библиотека трасс — `tracks` / `track_shares` (Stage C).
Перед миграцией существующей файловой БД v1/v2 создаётся WAL-aware backup
`cna.db.pre-v3-<timestamp>.db` (`VACUUM INTO`).

- `games` — одно PvP-лобби/игра: `lobby_code` (6 символов base32), `owner_account_id`
  (владелец = слот 0), `status` (`waiting`/`playing`/`finished`), `config_json`
  (таймер/трасса/сид/окно возврата), `state` (каноническое состояние движка, скрытое
  для клиентов — наружу отдаётся только проекция), `seq` (монотонный номер состояния).
- `game_players` — слоты 0–3: `account_id` (NULL для бота), `controller`
  (`human`/`bot`), `faction`, `joined_at` / `disconnected_at` (для окна возврата).

## Конфигурация (.env)

Скопируйте пример и заполните секрет:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # генерация PEPPER
```

Основные переменные (см. `.env.example`):

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `HOST` | `127.0.0.1` | Адрес прослушивания |
| `PORT` | `3000` | Порт |
| `DB_PATH` | `./cna.db` | Файл SQLite (или `:memory:`) |
| `CLIENT_DIR` | `../chrome-and-ash-web` | Каталог статического веб-клиента |
| `SESSION_TTL_DAYS` | `30` | Срок жизни сессии |
| `NODE_ENV` | `development` | `production` включает `Secure` у cookie (нужен HTTPS) |
| `PEPPER` | — | Серверный секрет для scrypt; **не менять после создания аккаунтов** |
| `ENGINE_DIR` | `../chrome-and-ash-web/js` | Каталог, откуда сервер грузит движок CnA (для PvP-движка) |
| `TRACK_LIBRARY_MAX` | `120` | Лимит запросов к библиотеке трасс на аккаунт |
| `TRACK_LIBRARY_WINDOW_MS` | `60000` | Окно лимита библиотеки, мс |

> `PEPPER` можно оставить пустым для локальной игры, но тогда он одинаков у всех
> локальных копий. Для сколь-нибудь долгой базы сгенерируйте уникальное значение.

## Полезные команды

```bash
npm start          # запуск (сервер + статика)
npm run dev        # запуск с авто-перезапуском (node --watch)
npm run db:init    # явная инициализация БД
npm test           # интеграционные тесты (node --test)
```

Проверка веб-клиента (независимо от сервера):

```bash
node ../chrome-and-ash-web/verify.mjs   # 29/29 PASS — логика, детерминизм, SaveState
```

## API (кратко)

Все эндпоинты под `/api`, auth через HttpOnly-cookie `cna_session`:

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | Живучесть |
| POST | `/api/auth/register` / `login` / `logout` | Аккаунт и сессия |
| GET | `/api/me` | Профиль + статистика + активная партия |
| GET | `/api/daily` | Ежедневное испытание (детерминированный сид) + топ |
| POST/GET | `/api/runs` | Создать/список заездов (один активный на аккаунт) |
| GET/PUT/DELETE | `/api/save/:id` | Сохранения (revision-блокировка, финализация результата) |
| GET | `/api/leaderboard` | Рейтинг (daily/race/championship) |
| GET/POST | `/api/tracks` | Библиотека трасс: список / создание (Stage C) |
| GET/PUT/DELETE | `/api/tracks/:id` | Трасса владельца; revision-блокировка, IDOR → 404 |
| GET/POST/DELETE | `/api/tracks/:id/share` | Статус / создать-rotate / отозвать unlisted-ссылку |
| GET | `/api/share/:token` | Публичное чтение share-ссылки без auth |
| POST | `/api/lobbies` | Создать PvP-лобби (владелец = слот 0) |
| GET | `/api/lobbies/:code` | Состояние лобби по коду |
| POST | `/api/lobbies/:code/join` / `leave` / `start` | Войти / выйти / стартовать |
| WS | `/ws` | PvP: `join_lobby`, `start_game`, `play_card`, `roll`, `end_turn`, `resign`, `ping`; входящие `hello`/`state`/`game_start`/`your_turn`/`turn_timeout`/`opponent_left`/`result` |

Полный REST-контракт: `../chrome-and-ash-web/docs/06-web-api.md`.
Полный PvP-контракт (WS + лобби): `docs/07-pvp-protocol.md`.
Машиночитаемые схемы: `api-schemas.json`.

## Структура

```
server/
├── src/
│   ├── server.js     # точка входа (БД + HTTP-сервер + attach PvP WebSocket)
│   ├── app.js        # createApp: REST-эндпоинты + монтирование pvp.router + статика
│   ├── db.js         # открытие БД + миграции v2->v3 + backup + очистка сессий
│   ├── init-db.js    # явная инициализация (npm run db:init)
│   ├── config.js     # env-конфигурация
│   ├── util.js       # scrypt / uuidv7 / session-токены / rate-limit
│   ├── daily.js      # детерминированный ежедневный сид
│   ├── engine.js     # загрузчик движка CnA из chrome-and-ash-web/js (общий с клиентом)
│   └── pvp.js        # PvP: WS /ws + лобби REST + авторитетный движок + таймер + боты
├── test/             # node:test (smoke + integration + pvp + pvp-e2e)
├── docs/07-pvp-protocol.md  # wire-контракт фазы 2 (WS + лобби + проекции)
├── schema.sql        # базовая схема v2 (без user_version); миграция v3 в src/db.js
├── api-schemas.json  # JSON Schema пакет (REST, включая Stage C tracks/share)
├── package.json
└── .env.example
```

## Частые проблемы

- **Порт занят** (`EADDRINUSE`): смените `PORT` в `.env` или остановите другой процесс.
- **`table ... already exists`**: не должно возникать (схема идемпотентна). Если БД создана
  старой версией, удалите `cna.db` и перезапустите.
- **Cookie не ставится в `production`**: `NODE_ENV=production` требует HTTPS (`Secure`);
  для localhost оставьте `development`.
- **Клиент не загружается**: проверьте, что `CLIENT_DIR` указывает на существующий
  `chrome-and-ash-web/` (по умолчанию — соседний каталог).
