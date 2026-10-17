import { fail, integer, text } from '../validation-core.mjs';

export const BUSINESS_TIME_ZONE = 'America/Bogota';
export const BUSINESS_PERIODS = Object.freeze(['day', 'week', 'month', 'quarter', 'halfyear', 'year']);
const DAY_MS = 86_400_000;
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

export function businessDate(value, label = 'Fecha', { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const date = text(value, label, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) fail(`${label}: fecha no válida.`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail(`${label}: fecha no válida.`);
  return date;
}

export function instant(value, label = 'Fecha y hora', { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const input = text(value, label, 40, true);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) fail(`${label}: incluye fecha, hora y zona horaria ISO.`);
  businessDate(match[1], label);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) fail(`${label}: hora no válida.`);
  if (match[6] !== 'Z' && (Number(match[6].slice(1, 3)) > 23 || Number(match[6].slice(4)) > 59)) fail(`${label}: zona horaria no válida.`);
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime())) fail(`${label}: instante no válido.`);
  return parsed.toISOString();
}

export function bogotaDate(now = new Date()) {
  let milliseconds;
  if (now instanceof Date) milliseconds = now.getTime();
  else if (typeof now === 'string') milliseconds = Date.parse(instant(now));
  else if (typeof now === 'number') milliseconds = now;
  if (!Number.isFinite(milliseconds)) fail('Fecha y hora: instante no válido.');
  const local = new Date(milliseconds - BOGOTA_OFFSET_MS);
  if (!Number.isFinite(local.getTime())) fail('Fecha y hora: instante no válido.');
  return businessDate(local.toISOString().slice(0, 10));
}

export function addDays(date, days) {
  const input = businessDate(date);
  integer(days, 'Días', -3_652_058, 3_652_058);
  const result = new Date(Date.parse(`${input}T00:00:00.000Z`) + days * DAY_MS);
  return businessDate(result.toISOString().slice(0, 10));
}

function monthStart(year, month) {
  return businessDate(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`);
}

export function periodBounds(period, anchorDate) {
  if (!BUSINESS_PERIODS.includes(period)) fail('Período no válido.');
  const anchor = businessDate(anchorDate);
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  let startDate;
  let endDateExclusive;
  if (period === 'day') {
    startDate = anchor;
    endDateExclusive = addDays(anchor, 1);
  } else if (period === 'week') {
    const weekday = new Date(`${anchor}T00:00:00.000Z`).getUTCDay();
    startDate = addDays(anchor, -((weekday + 6) % 7));
    endDateExclusive = addDays(startDate, 7);
  } else {
    const months = { month: 1, quarter: 3, halfyear: 6, year: 12 }[period];
    const firstMonth = Math.floor((month - 1) / months) * months + 1;
    startDate = monthStart(year, firstMonth);
    const nextMonth = firstMonth - 1 + months;
    endDateExclusive = monthStart(year + Math.floor(nextMonth / 12), nextMonth % 12 + 1);
  }
  return {
    startDate,
    endDateExclusive,
    startAt: `${startDate}T05:00:00.000Z`,
    endAt: `${endDateExclusive}T05:00:00.000Z`,
  };
}

export function priorPeriodBounds(period, anchorDate) {
  const current = periodBounds(period, anchorDate);
  return periodBounds(period, addDays(current.startDate, -1));
}
