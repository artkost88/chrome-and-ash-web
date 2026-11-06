#!/usr/bin/env node
/* Локальное зрение через Ollama (OpenAI-совместимый /v1/chat/completions).
   Не требует ключей и внешних сервисов. Модель по умолчанию qwen3.5:4b (уже есть vision).

   Пример:
     node tools/ollama-vision.js --image assets/art/test-tile.png --prompt "Опиши стиль"
     node tools/ollama-vision.js --image assets/art/test-tile.png --model qwen3.5:4b-dsh
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';

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
  if (!a.image) { console.error('Использование: node tools/ollama-vision.js --image <файл> --prompt "<вопрос>" [--model qwen3.5:4b]'); process.exit(1); }
  const imgPath = path.resolve(ROOT, a.image);
  if (!fs.existsSync(imgPath)) { console.error('Файл не найден: ' + imgPath); process.exit(2); }
  const mime = /\.(jpe?g)$/i.test(imgPath) ? 'image/jpeg' : 'image/png';
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const model = a.model || 'qwen3.5:4b';
  const prompt = a.prompt || 'Опиши изображение: что на нём, в каком стиле, читается ли композиция.';

  const body = {
    model,
    stream: false,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
    ] }],
  };
  const t0 = Date.now();
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) { console.error('HTTP ' + res.status + ': ' + JSON.stringify(j.error || j).slice(0, 400)); process.exit(1); }
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  console.log(text || JSON.stringify(j));
  console.error('[' + model + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 'с]');
})();
