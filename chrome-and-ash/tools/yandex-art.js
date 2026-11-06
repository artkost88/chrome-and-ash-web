#!/usr/bin/env node
/* Мост к Yandex ART через OpenAI-совместимый Images API (Yandex AI Studio).

   Читает ключ/каталог из chrome-and-ash/chrome-and-ash.env (или окружения), НЕ из чата/аргументов.
   Переменные (принимаются оба варианта имён):
     YC_FOLDER_ID  | YANDEX_FOLDER_ID   — каталог
     YC_API_KEY    | YANDEX_API_KEY     — API-ключ сервисного аккаунта
     YC_IAM_TOKEN  | YANDEX_IAM_TOKEN   — IAM-токен (вместо ключа)
     YANDEX_ART_MODEL                   — модель, по умолчанию aliceai-image-art-3.0
     YANDEX_AI_BASE                     — base URL, по умолчанию https://ai.api.cloud.yandex.net

   Примеры:
     node tools/yandex-art.js --prompt "cartoon hex tile" --out assets/art/tile.png --size 1024x1024
     node tools/yandex-art.js --prompt "..." --out assets/art/x.png --size 1024x1536 --model aliceai-image-art-3.0
     node tools/yandex-art.js --prompt "придумай промпт" --mode text      # YandexGPT (текст)
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AI_BASE = process.env.YANDEX_AI_BASE || 'https://ai.api.cloud.yandex.net';
const GPT_API = 'https://llm.api.cloud.yandex.net';

function loadEnv() {
  const env = { ...process.env };
  const files = [
    path.join(ROOT, 'chrome-and-ash.env'),
    path.join(ROOT, 'chrome-and-ash.env.txt'),
    path.join(ROOT, '.env'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) {
        env[m[1]] = env[m[1]] || m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return env;
}

function args() {
  const a = process.argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = a[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(k);
  }
  return out;
}

function help() {
  console.log('Использование:');
  console.log('  node tools/yandex-art.js --prompt "..." --out path.png [--size 1024x1024] [--model aliceai-image-art-3.0]');
  console.log('  node tools/yandex-art.js --prompt "..." --mode text        # только текст YandexGPT');
  console.log('Размеры: 1024x1024, 1024x1536 и т.п. (WxH).');
}

async function generateImage(bearer, folderId, model, prompt, size) {
  const url = AI_BASE + '/v1/images/generations';
  const body = {
    model: `art://${folderId}/${model}/latest`,
    prompt,
    size: size || '1024x1024',
    n: 1,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + bearer,
      'OpenAI-Project': folderId,
      'User-Agent': 'yandex-art-plugin/0.2',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 600));
  const data = await res.json();
  const first = data && data.data && data.data[0];
  const b64 = first && (first.b64_json || first.url);
  if (!b64) throw new Error('Нет изображения в ответе: ' + JSON.stringify(data).slice(0, 300));
  return { b64, meta: first };
}

async function yandexGptText(apiKey, iamToken, folderId, prompt) {
  const auth = iamToken ? 'Bearer ' + iamToken : 'Api-Key ' + apiKey;
  const res = await fetch(GPT_API + '/foundationModels/v1/completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({
      modelUri: `gpt://${folderId}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature: 0.7, maxTokens: '2000' },
      messages: [{ role: 'user', text: prompt }],
    }),
  });
  if (!res.ok) throw new Error('YandexGPT HTTP ' + res.status + ': ' + await res.text());
  const data = await res.json();
  const alt = data.result && data.result.alternatives && data.result.alternatives[0];
  return alt && alt.message && alt.message.text ? alt.message.text : JSON.stringify(data);
}

(async () => {
  const a = args();
  if (a.help) { help(); process.exit(0); }
  if (!a.prompt) { help(); process.exit(1); }

  const env = loadEnv();
  const folderId = env.YC_FOLDER_ID || env.YANDEX_FOLDER_ID;
  const apiKey = env.YC_API_KEY || env.YANDEX_API_KEY;
  const iamToken = env.YC_IAM_TOKEN || env.YANDEX_IAM_TOKEN;

  if (!apiKey && !iamToken) { console.error('Не найден API-ключ/токен: положите в chrome-and-ash/chrome-and-ash.env (не в чат).'); process.exit(2); }
  if (!folderId) { console.error('Не найден каталог (YC_FOLDER_ID / YANDEX_FOLDER_ID).'); process.exit(2); }

  try {
    if (a.mode === 'text') {
      console.log(await yandexGptText(apiKey, iamToken, folderId, a.prompt));
      process.exit(0);
    }

    let prompt = a.prompt;
    if (a.refine) {
      prompt = await yandexGptText(apiKey, iamToken, folderId,
        'Улучши этот промпт для генерации картинки: сохрани суть, добавь свет, композицию и стиль. Ответь ТОЛЬКО готовым промптом на английском, без пояснений.\n\n' + a.prompt);
      console.log('REFINED: ' + prompt);
    }

    if (!a.out) { console.error('Укажите --out для сохранения картинки.'); process.exit(1); }

    const model = a.model || env.YANDEX_ART_MODEL || 'aliceai-image-art-3.0';
    const bearer = iamToken || apiKey;
    const { b64 } = await generateImage(bearer, folderId, model, prompt, a.size);

    const outPath = path.resolve(ROOT, a.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    console.log(JSON.stringify({ path: outPath, model, size: a.size || '1024x1024' }));
  } catch (e) {
    console.error('Ошибка:', e.message || e);
    process.exit(1);
  }
})();
