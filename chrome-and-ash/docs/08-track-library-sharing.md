# Библиотека трасс и share-ссылки (Stage C)

**Статус:** проектный контракт Stage C. Код не меняется этим документом.
**Область:** серверная библиотека пользовательских трасс и **unlisted** публичные share-ссылки. Локальный конструктор сохраняется как offline-режим.
**База:** `TrackSpec schemaVersion: 1`; локальный стор `cna.customTracks.v1`; существующий REST-стиль `docs/06-web-api.md`.
**Вне scope:** публичный каталог/поиск трасс, несколько share-ссылок на трассу, срок жизни ссылки, совместное редактирование, изменение `runs`/лидербордов, PvP.

---

## 1. Решения

1. **Источник правды на сервере:** только канонический **editable axial TrackSpec v1**. Сервер принимает 24–36 main-тайлов, валидный старт/КП/grid/пит/срез/опасности, без object-decor/legacy fork/polar/read-only. Read-only трассы можно экспортировать локально, но не загружать в библиотеку.
2. **ID:** серверный `UUIDv7`; локальные `custom-*` id не используются как серверные. Клиент хранит mapping `localId ↔ serverId`.
3. **Конкурентность:** `revision` (integer) по каждой трассе. `PUT` принимает `revision`; несовпадение → `409 stale_revision`; никаких read-then-write.
4. **Share:** одна unlisted-ссылка на трассу, живая (при обновлении трассы ссылка отдаёт актуальный spec). Rotate заменяет токен, revoke удаляет. Токен показывается один раз; в БД только `sha256(token)`.
5. **IDOR:** для чужих/несуществующих приватных id — **404** (не 403), чтобы не раскрывать существование. Владелец — только из `req.account`, никогда из body/query.
6. **Публичный share:** без auth, только `{name, spec, author.displayName, updatedAt}`; без account id/email/других трасс. `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`.
7. **Клиентский share route:** query `?track=<token>` (без path-SPA-fallback). Обрабатывается до `/api/me`/auth-гейта; после загрузки — read-only preview с кнопками «Импортировать копию» / «Тест-драйв», без записи до явного действия.
8. **Лимиты:** 40 трасс на аккаунт; имя 1–40 (trim, strip HTML); spec JSON ≤100 КБ; body ≤512 КБ; list limit ≤100; auth library 30 req/min, public share 60 req/min per IP+token hash.
9. **Run metadata:** не входит в C v1. `runs`/daily/PvP/leaderboard не меняются.

---

## 2. БД и миграция

Новые таблицы, аддитивно; существующие данные не переписываются.

```sql
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_schema INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_owner_updated ON tracks(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS track_shares (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_track_shares_track ON track_shares(track_id);
```

- `openDb()` применяет миграцию v3 **транзакционно**; `PRAGMA user_version` выставляется в 3 только после успеха.
- Повторное открытие v3 — no-op. Старый сервер v2 игнорирует новые таблицы.
- `ON DELETE CASCADE` удаляет share при удалении трассы/аккаунта.
- Тест на **файловой populated v2 DB** (не только `:memory:`): старые accounts/runs/saves/daily/PvP читаются после миграции; повторный open идемпотентен.
- Перед миграцией — backup `DB_PATH`; rollback = restore backup, новый код с новыми таблицами старый не ломает.

---

## 3. REST API

Все `/api/tracks*` требуют auth; ошибки `{error:{code,message}}`.

| Метод | Путь | Тело | Успех |
|---|---|---|---|
| GET | `/api/tracks?limit=&cursor=` | — | `200 {tracks:[{id,name,size,archetype,revision,updatedAt,share:{active,updatedAt}}],nextCursor}` |
| POST | `/api/tracks` | `{name,spec}` | `201 {track:{id,name,spec,revision,...}}` |
| GET | `/api/tracks/:id` | — | `200 {track}` (own) |
| PUT | `/api/tracks/:id` | `{revision,name,spec}` | `200 {track}`; stale → `409 stale_revision` |
| DELETE | `/api/tracks/:id` | — | `204`; share каскадно удаляется |
| GET | `/api/tracks/:id/share` | — | `200 {share:{active,createdAt,updatedAt}}`; raw token не возвращается |
| POST | `/api/tracks/:id/share` | — | `200/201 {share:{token,url}}`; rotate/create, raw token один раз |
| DELETE | `/api/tracks/:id/share` | — | `204`; повторный revoke — `204` (идемпотентно) |
| GET | `/api/share/:token` | — | `200 {track:{name,spec,author:{displayName},updatedAt}}`; иначе `404` |

Статусы: `401 unauthorized`, `404 not_found` (чужая/нет трассы/токена), `409 stale_revision`, `422 invalid_track | invalid_name`, `413 payload_too_large`, `429 rate_limited`.

`POST /api/tracks/:id/share`: `token = crypto.randomBytes(32).toString('base64url')`; URL `/?track=<token>`; в БД `token_hash=sha256Hex(token)`. Rotate удаляет/заменяет старую запись в одной транзакции.

Публичный `GET /api/share/:token`:
- `token_hash` lookup, `revoked_at IS NULL`, track существует.
- Тело проходит серверную валидацию перед отдачей; если сохранённый spec когда-то стал невалиден — `404` и лог без spec.
- Никаких `account_id`, email, session, token_hash, других трасс.
- `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`.

---

## 4. Серверная валидация

Новый `server/src/track-spec.js` загружает **тот же** клиентский pure-код через изолированный `vm`-контекст:
`data.js → track-gen.js → track-editor.js`; экспортирует `report(spec)`, `prepareSpec`, `cleanName`, `validateTrackSpec`.
Не дублировать правила и не доверять `readOnly`/canonical-флагам клиента.

Проверки перед записью:
- объект, `schemaVersion===1`, `layout==='axial'`, `levels===1`, `hexSize` finite;
- `prepareSpec`/`validateStructural` + `validateTrackSpec` ok; reject `readOnly`/`originalSpec`-only;
- main 24–36, плотные уникальные id, один start, один CP 25–65 %, grid 2×2, branch rules, no object decor/fork/polar;
- имя: strip HTML, trim, 1–40; reject duplicate? **разрешаем** (id уникален);
- spec JSON ≤100 КБ (после serialize), body ≤512 КБ; лимит 40 трасс.

Ошибки: `422 invalid_track` с первыми issue codes (не полный spec), `413` size, `400` JSON.

---

## 5. Клиент

### API-клиент
Добавить в `chrome-and-ash-web/js/api.js`:
`tracks.list/get/create/update/delete`, `share.create/status/revoke`, `shared.get(token)`.
Все private — `credentials:'include'`; публичный `shared.get` без auth.

### UI конструктора
- Новая секция «БИБЛИОТЕКА»: список серверных трасс, «В библиотеку» (create/update), «Сохранить копию», «Удалить».
- Локальный стор остаётся; локальные и серверные трассы показываются раздельно; mapping `serverId` хранится в local envelope (`serverId`, `serverRevision`).
- Конфликт `409`: модал «Перезагрузить / Перезаписать / Сохранить копией / Отмена»; default — «Сохранить копией».
- «Поделиться»: показать URL один раз + copy; статус «Ссылка активна»; «Обновить ссылку» (rotate); «Отозвать».
- Сервер недоступен: local-only продолжает работать, показывается offline-статус; никаких потерь dirty.
- Shared `?track=<token>`: до auth-гейта; read-only preview/стата; «Импортировать копию» создаёт новую локальную/серверную трассу; «Тест-драйв» разрешён; edit/save/share disabled.
- XSS: `textContent`/`esc` для имён/ошибок; не вставлять токен в DOM вне share-блока.

### Синхронизация
- Server create/update only explicit; никогда не автосинхронизировать локальные трассы.
- `PUT` всегда с `serverRevision`; при 409 не менять локальную копию до выбора пользователя.
- Delete server track: локальная копия остаётся, `serverId` очищается.
- Shared import always copy; source immutable.
- `?track` route не пишет в localStorage автоматически.

---

## 6. Тесты и приёмка

**Server**
- migration v2 file DB → v3, old rows intact, idempotent; fresh v3; cascade delete.
- auth/IDOR matrix A/B for GET/PUT/DELETE/share; foreign/missing → 404; list only own.
- CRUD/revision 409; quota 40; validation invalid/oversized/read-only/polar/object-decor; name XSS/length.
- share token entropy/hash/no token in responses except create; rotate old 404; revoke 404/idempotent; public read no auth/no PII; no token in list.
- rate limit 429; no partial DB writes; daily/runs/saves/PvP regressions.

**Web**
- Existing 100/77/31 suites green.
- Browser E2E: save to library, reload, share/copy URL, fresh no-cookie open, read-only edit blocked, import copy, rotate/revoke, conflict 409, server-down local fallback, 1024/1280/1600 no overflow, no console errors.

**Acceptance commands**
`cd server && node --test`, `node --test chrome-and-ash-web/tests`, `node chrome-and-ash-web/verify.mjs`, plus Stage C API/UI QA; migration file fixture; `git diff --check`.

---

## 7. Этапы и файлы

1. **C1** DB migration v3 + `track-spec.js` shared validator + tests. `server/src/db.js`, `server/src/track-spec.js`, `server/test/migration.test.js`.
2. **C2** server `/api/tracks`, `/api/share` routes, tokens, limits + tests. `server/src/app.js`, `server/src/track-spec.js`, `server/test/tracks.test.js`, `chrome-and-ash/docs/06-web-api.md`.
3. **C3** client API + local↔server mapping. `chrome-and-ash-web/js/api.js`, `track-editor.js`.
4. **C4** constructor library/share UI + conflicts/offline. `track-editor-ui.js`, `index.html`, `style.css`.
5. **C5** public `?track=` route/read-only/import copy + E2E.
6. **C6** documentation, QA, deploy.

Не менять `track-gen.js`/`engine.js`/`ui.js` без отдельного согласования; `runs`/daily/PvP/leaderboard вне scope.

---

## 8. Явные ограничения C v1

- Публичный каталог/поиск отсутствует; только unlisted-ссылка.
- Одна активная share-ссылка на трассу; без срока действия.
- Share «живая»: изменения трассы видны по ссылке; revoke/rotate немедленно.
- Server library только canonical editable axial TrackSpec; legacy/read-only не загружаются.
- Run metadata custom track и лидерборд-политика — отдельный этап.
- Совместное редактирование и realtime — вне scope.
