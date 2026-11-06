# Мост к Yandex ART / YandexGPT

Два сервиса, один ключ:

- **Yandex ART** — генерация картинок через OpenAI-совместимый Images API;
- **YandexGPT** — уточнение промптов (REST).

Мост `tools/yandex-art.js` ходит по обычному HTTP, бэкенд не нужен.

## Настройка (ключ — не в чат!)

Создайте `chrome-and-ash/chrome-and-ash.env`:

```
YC_API_KEY=<ключ>
YC_FOLDER_ID=<id каталога>
```

Мост читает по очереди: `chrome-and-ash.env`, `chrome-and-ash.env.txt`, `.env`. Удобно скопировать `chrome-and-ash.env.example`. Файл с ключом не должен попадать в переписку, в git и в `dist/`.

## Запуск

```bash
# картинка 1:1
node tools/yandex-art.js --prompt "cartoon hex tile, desert sand, thick black outline" --out assets/art/tile.png --size 1024x1024

# вертикальная
node tools/yandex-art.js --prompt "..." --out assets/art/cover.png --size 1024x1536

# уточнить промпт через YandexGPT, затем сгенерировать
node tools/yandex-art.js --prompt "..." --out assets/art/x.png --refine

# только текст YandexGPT
node tools/yandex-art.js --prompt "придумай промпт" --mode text
```

Размеры — строкой `WxH` (например `1024x1024`, `1024x1536`). Модель по умолчанию `aliceai-image-art-3.0` (можно переопределить `--model` или `YANDEX_ART_MODEL`).

## Замечания по API

- Endpoint: `POST https://ai.api.cloud.yandex.net/v1/images/generations`.
- Заголовки: `Authorization: Bearer <ключ>` + `OpenAI-Project: <каталог>`.
- Модель в запросе: `art://<каталог>/aliceai-image-art-3.0/latest`.
- Ответ синхронный: картинка приходит как base64 в `data[0].b64_json`.
