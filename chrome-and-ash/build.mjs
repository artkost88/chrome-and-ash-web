import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');

/* CSS инлайнится в <style> внутри dist/chrome-and-ash.html. В исходнике style.css
   лежит в css/, поэтому пути к арту там — '../assets/...'. После инлайна базовый
   URL документа = dist/, и '../assets/...' указывал бы на chrome-and-ash/assets
   (мимо dist/assets). Переписываем в 'assets/...' — тогда картинки подхватятся из
   dist/assets/, лежащего рядом с одностраничником. */
const css = read('css/style.css').replace(/url\(\s*(['"]?)\.\.\/assets\//g, 'url($1assets/');
html = html.replace('<link rel="stylesheet" href="css/style.css">', () => '<style>\n' + css + '\n</style>');

const scripts = ['js/data.js', 'js/assets.js', 'js/track-gen.js', 'js/track.js', 'js/engine.js', 'js/ai.js', 'js/ui.js'];
for (const file of scripts) {
  const tag = '<script src="' + file + '"></script>';
  if (!html.includes(tag)) throw new Error('Не найден тег ' + tag);
  html = html.replace(tag, () => '<script>\n' + read(file) + '\n</script>');
}

if (html.includes('href="css/') || html.includes('src="js/')) {
  throw new Error('Остались внешние ссылки — сборка неполная');
}

const out = path.join(root, 'dist', 'chrome-and-ash.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log('Собрано: ' + out + ' (' + Math.round(Buffer.byteLength(html, 'utf8') / 1024) + ' КБ)');

copyAssets();

/**
 * Копирует арт рядом с одностраничником: assets/ → dist/assets/.
 * В дистрибутив попадают только .png (рантайм-арт):
 *   - assets/art/ (scratch-зона генератора) исключается целиком;
 *   - .gitkeep (пустые папки) и manifest.json (инструментальный, для Node) — нет.
 * Пути в JS остаются 'assets/...' и работают из корня dist/.
 */
function copyAssets() {
  const srcDir = path.join(root, 'assets');
  const dstDir = path.join(root, 'dist', 'assets');
  if (!fs.existsSync(srcDir)) return;

  fs.rmSync(dstDir, { recursive: true, force: true });

  let count = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.relative(srcDir, path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (rel === 'art' || rel.startsWith('art' + path.sep)) continue; // scratch
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (entry.name === '.gitkeep') continue;
        if (!entry.name.endsWith('.png')) continue;
        const target = path.join(dstDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(dir, entry.name), target);
        count++;
      }
    }
  }
  walk(srcDir);
  console.log('Скопирован арт: ' + count + ' png → ' + path.relative(root, dstDir));
}
