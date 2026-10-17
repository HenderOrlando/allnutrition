import { fail, integer, text } from '../validation-core.mjs';

export const MAX_MONEY_MINOR = 10_000_000_000_000;

export function moneyMinor(value, label = 'Importe', { signed = false } = {}) {
  return integer(value, label, signed ? -MAX_MONEY_MINOR : 0, MAX_MONEY_MINOR);
}

export function pesosToMinor(value, label = 'Precio', { signed = false } = {}) {
  integer(value, label, signed ? -MAX_MONEY_MINOR / 100 : 0, MAX_MONEY_MINOR / 100);
  return moneyMinor(value * 100, label, { signed });
}

// Grouping is explicit: no locale guessing and no floating-point parsing.
export function parseMoneyMinor(value, { decimalSeparator = ',', groupSeparator = '.' } = {}) {
  if (!['.', ','].includes(decimalSeparator)
    || !['', '.', ',', ' ', '\u00a0', '\u202f', "'"].includes(groupSeparator)
    || decimalSeparator === groupSeparator) fail('Importe: separadores no válidos.');
  let input = text(value, 'Importe', 100, true);
  let sign = 1n;
  if (input[0] === '-' || input[0] === '+') {
    if (input[0] === '-') sign = -1n;
    input = input.slice(1);
  }
  const parts = input.split(decimalSeparator);
  if (parts.length > 2 || (parts.length === 2 && !/^\d{1,2}$/.test(parts[1]))) {
    fail('Importe: usa como máximo dos decimales.');
  }
  const groups = groupSeparator ? parts[0].split(groupSeparator) : [parts[0]];
  if (!/^\d+$/.test(groups[0]) || (groups.length > 1
    && (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(group => !/^\d{3}$/.test(group))))) {
    fail('Importe: agrupación de miles no válida.');
  }
  const amount = sign * (BigInt(groups.join('')) * 100n + BigInt((parts[1] ?? '').padEnd(2, '0')));
  if (amount < -BigInt(MAX_MONEY_MINOR) || amount > BigInt(MAX_MONEY_MINOR)) fail('Importe: excede el límite permitido.');
  return Number(amount);
}

const wholeFormatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 0 });

export function formatMoneyMinor(amount) {
  integer(amount, 'Importe', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const absolute = BigInt(amount < 0 ? -amount : amount), cents = absolute % 100n;
  return `${amount < 0 ? '-' : ''}${wholeFormatter.format(absolute / 100n)}${cents ? `,${String(cents).padStart(2,'0')}` : ''}`;
}

function exactInteger(value, label) {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) fail(`${label}: se esperaba un entero seguro.`);
  return BigInt(value);
}

// Callers can multiply BigInts before dividing without losing a single cent.
export function roundRatio(numerator, denominator) {
  const n = exactInteger(numerator, 'Numerador');
  const d = exactInteger(denominator, 'Denominador');
  if (d <= 0n) fail('Denominador: debe ser positivo.');
  const magnitude = n < 0n ? -n : n;
  const rounded = magnitude / d + (2n * (magnitude % d) >= d ? 1n : 0n);
  const result = n < 0n ? -rounded : rounded;
  if (result < BigInt(Number.MIN_SAFE_INTEGER) || result > BigInt(Number.MAX_SAFE_INTEGER)) fail('Resultado: excede el rango entero seguro.');
  return Number(result);
}
