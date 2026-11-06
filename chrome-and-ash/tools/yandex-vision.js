#!/usr/bin/env node
/* Yandex vision (мультимодальные модели) через Foundation Models completion API.
   Ключ/каталог читает из chrome-and-ash/chrome-and-ash.env (не из чата).

   Пример: node tools/yandex-vision.js --image assets/art/test-tile.png --prompt "Опиши изображение"
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completionAsync';

function loadEnv() {
  const env = { ...process.env };
  for (const file of ['chrome-and-ash.env', 'chrome-and-ash.env.txt', '.env']) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = env[m[1]] || m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

function args() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = a[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

(async () => {
  const a = args();
  if (!a.image || !a.prompt) { console.error('Использование: node tools/yandex-vision.js --image <файл> --prompt "<вопрос>" [--model qwen2.5-vl-7b-instruct]'); process.exit(1); }

  const env = loadEnv();
  const folderId = env.YC_FOLDER_ID || env.YANDEX_FOLDER_ID;
  const apiKey = env.YC_API_KEY || env.YANDEX_API_KEY;
  const iamToken = env.YC_IAM_TOKEN || env.YANDEX_IAM_TOKEN;
  if (!apiKey && !iamToken) { console.error('Нет ключа в chrome-and-ash/chrome-and-ash.env'); process.exit(2); }
  if (!folderId) { console.error('Нет каталога в chrome-and-ash/chrome-and-ash.env'); process.exit(2); }

  const imgPath = path.resolve(ROOT, a.image);
  if (!fs.existsSync(imgPath)) { console.error('Файл не найден: ' + imgPath); process.exit(2); }
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const mime = imgPath.toLowerCase().endsWith('.jpg') || imgPath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const model = a.model || 'qwen2.5-vl-7b-instruct';
  const auth = iamToken ? 'Bearer ' + iamToken : 'Api-Key ' + apiKey;

  const body = {
    modelUri: `gpt://${folderId}/${model}/`,
    completionOptions: { stream: false, temperature: 0.3, maxTokens: '2000' },
    messages: [{
      role: 'user',
      text: a.prompt,
      contents: [{ type: 'image', image: { imageData: b64, mimeType: mime } }],
    }],
  };

  const headers = { 'Content-Type': 'application/json', Authorization: auth };
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) { console.error('HTTP ' + res.status + ': ' + text.slice(0, 800)); process.exit(1); }

  const data = JSON.parse(text);

  // Асинхронный ответ → есть id операции, опрашиваем до готовности.
  if (data.id) {
    const opUrl = 'https://llm.api.cloud.yandex.net/operations/' + data.id;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const opRes = await fetch(opUrl, { headers: { Authorization: auth } });
      const op = await opRes.json();
      if (op.done) {
        if (op.error) { console.error('Ошибка операции: ' + JSON.stringify(op.error)); process.exit(1); }
        const alt = op.response && op.response.alternatives && op.response.alternatives[0];
        console.log(alt && alt.message ? alt.message.text : JSON.stringify(op.response));
        process.exit(0);
      }
    }
    console.error('Таймаут ожидания операции');
    process.exit(1);
  }

  const alt = data.result && data.result.alternatives && data.result.alternatives[0];
  console.log(alt && alt.message ? alt.message.text : JSON.stringify(data));
})();
