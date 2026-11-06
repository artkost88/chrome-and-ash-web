import crypto from 'node:crypto';

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MiB

/** ISO-8601 UTC с миллисекундами и суффиксом Z. */
export function nowIso(d = new Date()) {
  return d.toISOString();
}

/** Дата YYYY-MM-DD в UTC. */
export function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** UUIDv7: 48-битная метка времени + версия 7 + вариант 10 + случайность. */
export function uuidv7(now = Date.now()) {
  const tHex = BigInt(now).toString(16).padStart(12, '0');
  const b = crypto.randomBytes(10);
  b[0] = (b[0] & 0x0f) | 0x70; // версия 7
  b[2] = (b[2] & 0x3f) | 0x80; // вариант 10 (RFC 4122)
  const hex = b.toString('hex');
  return `${tHex.slice(0, 8)}-${tHex.slice(8, 12)}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 20)}`;
}

export function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** scrypt-хэш пароля. Формат: scrypt$N$r$p$saltHex$hashHex */
export function hashPassword(password, pepper = '') {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pepper + password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Проверка пароля против сохранённого scrypt-хэша (timing-safe). */
export function verifyPassword(password, stored, pepper = '') {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (!salt.length || !expected.length) return false;
  const actual = crypto.scryptSync(pepper + password, salt, expected.length, {
    N, r, p, maxmem: SCRYPT_MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** Генерирует токен сессии и его sha256-хэш для хранения. */
export function newSessionToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256Hex(token) };
}

/**
 * Съедает ту же стоимость scrypt, что и verifyPassword, и всегда возвращает false.
 * Нужна, чтобы время ответа login не различалось для существующего и несуществующего
 * аккаунта (защита от тайминг-перечисления имён).
 */
export function dummyVerifyPassword(password, pepper = '') {
  const salt = Buffer.alloc(16, 0x5a);
  const hash = crypto.scryptSync(pepper + password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  crypto.timingSafeEqual(hash, Buffer.alloc(SCRYPT_PARAMS.keylen, 0xa5));
  return false;
}

/** Лёгкий in-memory лимитер с фиксированным окном (для rate limiting, без зависимостей). */
export function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return {
    allow(key, now = Date.now()) {
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowMs };
        buckets.set(key, b);
      }
      if (b.count >= max) return false;
      b.count += 1;
      // Периодическая обрезка, чтобы карта не росла бесконечно.
      if (buckets.size > 20000) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      }
      return true;
    },
  };
}
