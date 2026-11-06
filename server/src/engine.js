import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENGINE_DIR = path.join(__dirname, '..', '..', 'chrome-and-ash-web', 'js');

/**
 * Загружает классические IIFE-скрипты движка (data/track/engine/ai) в globalThis
 * и возвращает общий объект CnA. Движок детерминирован и общий с веб-клиентом.
 */
export function loadEngine(engineDir = process.env.ENGINE_DIR || DEFAULT_ENGINE_DIR) {
  if (globalThis.__CnA_LOADED__) return globalThis.CnA;
  for (const name of ['data.js', 'track-gen.js', 'track.js', 'engine.js', 'ai.js']) {
    const code = readFileSync(path.join(engineDir, name), 'utf8');
    (0, eval)(code);
  }
  globalThis.__CnA_LOADED__ = true;
  return globalThis.CnA;
}

export const CnA = loadEngine();
