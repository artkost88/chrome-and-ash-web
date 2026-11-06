#!/usr/bin/env node
/* Yandex Vision OCR — распознавание текста на изображении.
   Ключ/каталог из chrome-and-ash/chrome-and-ash.env (не из чата).

   Пример: node tools/yandex-ocr.js --image assets/art/test-tile.png
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = 'https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze';

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
  if (!a.image) { console.error('Использование: node tools/yandex-ocr.js --image <файл>'); process.exit(1); }

  const env = loadEnv();
  const folderId = env.YC_FOLDER_ID || env.YANDEX_FOLDER_ID;
  const apiKey = env.YC_API_KEY || env.YANDEX_API_KEY;
  const iamToken = env.YC_IAM_TOKEN || env.YANDEX_IAM_TOKEN;
  if (!apiKey && !iamToken) { console.error('Нет ключа'); process.exit(2); }
  if (!folderId) { console.error('Нет каталога'); process.exit(2); }

  const imgPath = path.resolve(ROOT, a.image);
  if (!fs.existsSync(imgPath)) { console.error('Файл не найден: ' + imgPath); process.exit(2); }
  const b64 = fs.readFileSync(imgPath).toString('base64');

  const body = {
    folderId,
    analyzeSpecs: [{
      content: b64,
      mimeType: imgPath.toLowerCase().endsWith('.jpg') || imgPath.toLowerCase().endsWith('.jpeg') ? 'JPEG' : 'PNG',
      features: [{ type: 'TEXT_DETECTION', textDetectionConfig: { languageCodes: ['ru', 'en'] } }],
    }],
  };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: iamToken ? 'Bearer ' + iamToken : 'Api-Key ' + apiKey,
    'x-folder-id': folderId,
  };

  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) { console.error('HTTP ' + res.status + ': ' + text.slice(0, 800)); process.exit(1); }

  const data = JSON.parse(text);
  const blocks = (data.results && data.results[0] && data.results[0].textDetection && data.results[0].textDetection.pages || [])
    .flatMap((p) => p.blocks || [])
    .flatMap((b) => b.lines || [])
    .map((l) => l.text || '');
  if (blocks.length) {
    console.log('ТЕКСТ НА ИЗОБРАЖЕНИИ:');
    console.log(blocks.join('\n'));
  } else {
    console.log('(текст не найден)');
  }
})();
