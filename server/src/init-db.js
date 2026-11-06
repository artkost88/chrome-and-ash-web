import { config } from './config.js';
import { openDb } from './db.js';

// Явная инициализация БД: создаёт файл (если отсутствует) и применяет schema.sql.
// Идемпотентна — повторный запуск по существующей БД безопасен (IF NOT EXISTS).
// Используется командой `npm run db:init`; при обычном `npm start` БД инициализируется
// автоматически через тот же openDb().
const db = openDb(config.dbPath);
const { size } = db.prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get();
const userVersion = db.prepare('PRAGMA user_version').get().user_version;
db.close();
console.log(`[cna] БД инициализирована: ${config.dbPath}`);
console.log(`[cna] user_version = ${userVersion}, размер страницы ≈ ${size} байт`);
