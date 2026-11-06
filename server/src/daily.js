import crypto from 'node:crypto';
import { utcDateString } from './util.js';

export const FACTIONS = ['chrome', 'rust', 'carnival', 'swarm'];

/** Детерминированный сид ежедневного заезда по дате (YYYY-MM-DD). */
export function dailySeed(dateStr) {
  const h = crypto.createHash('sha256').update('cna:daily:' + dateStr).digest();
  return h.readUInt32BE(0) >>> 1; // 31-битный неотрицательный сид
}

/** Детерминированная ротация фракции по дате. */
export function dailyFaction(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayIndex = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return FACTIONS[((dayIndex % FACTIONS.length) + FACTIONS.length) % FACTIONS.length];
}

/** Полные фиксированные условия ежедневного заезда на дату. */
export function dailyChallenge(dateStr) {
  return {
    mode: 'daily',
    seed: dailySeed(dateStr),
    faction: dailyFaction(dateStr),
    trackKind: 'mosaic',
    trackSize: 36,
    laps: 1,
  };
}

/** Сегодняшняя дата (UTC) — канонический ключ ежедневного заезда. */
export function today() {
  return utcDateString();
}
