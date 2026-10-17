import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MONEY_MINOR, moneyMinor, pesosToMinor, parseMoneyMinor, formatMoneyMinor, roundRatio } from '../lib/business/money.mjs';
import { BUSINESS_PERIODS, businessDate, instant, bogotaDate, addDays, periodBounds, priorPeriodBounds } from '../lib/business/dates.mjs';

const invalid = fn => assert.throws(fn, { status: 400 });

test('localized amounts preserve exact cents, grouping and signs', () => {
  assert.equal(parseMoneyMinor(' 1.234.567,89 '), 123456789);
  assert.equal(parseMoneyMinor('-20.000,01'), -2000001);
  assert.equal(parseMoneyMinor('+0,1'), 10);
  assert.equal(parseMoneyMinor('0'), 0);
  assert.equal(parseMoneyMinor('1,234.50', { decimalSeparator: '.', groupSeparator: ',' }), 123450);
  assert.equal(parseMoneyMinor('1234.50', { decimalSeparator: '.', groupSeparator: '' }), 123450);
  assert.equal(parseMoneyMinor('1 234,50', { decimalSeparator: ',', groupSeparator: ' ' }), 123450);
  assert.equal(parseMoneyMinor('1\u00a0234,50', { decimalSeparator: ',', groupSeparator: '\u00a0' }), 123450);
  assert.equal(parseMoneyMinor('000012,03'), 1203);
});

test('money parser rejects malformed groups, ambiguous precision and non-text', () => {
  for (const value of ['', ' ', '1.23,45', '1234.567', '1..000', '1,234', '1,', ',50', '1e3', '$ 100', '--1', '1 000', 'NaN', 12, null]) {
    invalid(() => parseMoneyMinor(value));
  }
  invalid(() => parseMoneyMinor('1', { decimalSeparator: ',', groupSeparator: ',' }));
  invalid(() => parseMoneyMinor('1', { decimalSeparator: ';', groupSeparator: '.' }));
});

test('money limits apply symmetrically without unsafe intermediate parsing', () => {
  assert.equal(parseMoneyMinor('100.000.000.000,00'), MAX_MONEY_MINOR);
  assert.equal(parseMoneyMinor('-100.000.000.000,00'), -MAX_MONEY_MINOR);
  invalid(() => parseMoneyMinor('100.000.000.000,01'));
  invalid(() => parseMoneyMinor('-100.000.000.000,01'));
  assert.equal(moneyMinor(0), 0);
  assert.equal(moneyMinor(MAX_MONEY_MINOR), MAX_MONEY_MINOR);
  assert.equal(moneyMinor(-1, 'Ajuste', { signed: true }), -1);
  for (const value of [-1, 0.1, '1', NaN, Infinity, MAX_MONEY_MINOR + 1]) invalid(() => moneyMinor(value));
  assert.equal(pesosToMinor(20000), 2000000);
  assert.equal(pesosToMinor(100000000000), MAX_MONEY_MINOR);
  assert.equal(pesosToMinor(-2, 'Ajuste', { signed: true }), -200);
  for (const value of [1.5, -1, 100000000001]) invalid(() => pesosToMinor(value));
});

test('COP display shows cents only when fractional and keeps their exact value', () => {
  const whole = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const cents = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.equal(formatMoneyMinor(2000000), whole.format(20000));
  assert.equal(formatMoneyMinor(2000001), cents.format(20000.01));
  assert.equal(formatMoneyMinor(-1), cents.format(-0.01));
  assert.equal(formatMoneyMinor(0), whole.format(0));
  invalid(() => formatMoneyMinor(0.5));
});

test('COP aggregate display preserves safe-integer cents beyond the document limit', () => {
  assert.equal(formatMoneyMinor(MAX_MONEY_MINOR+1).replace(/\s/g,''),'$100.000.000.000,01');
  assert.equal(formatMoneyMinor(Number.MAX_SAFE_INTEGER).replace(/\s/g,''),'$90.071.992.547.409,91');
  assert.equal(formatMoneyMinor(-Number.MAX_SAFE_INTEGER).replace(/\s/g,''),'-$90.071.992.547.409,91');
  invalid(()=>formatMoneyMinor(Number.MAX_SAFE_INTEGER+1));
});

test('ratio rounding is half away from zero, including BigInt products', () => {
  for (const [n, d, expected] of [[1, 2, 1], [-1, 2, -1], [4, 3, 1], [-4, 3, -1], [5, 2, 3], [-5, 2, -3], [0, 3, 0]]) {
    assert.equal(roundRatio(n, d), expected);
  }
  assert.equal(roundRatio(10000000000000n * 9999n, 10000n), 9999000000000);
  assert.equal(roundRatio(-10000000000000n * 9999n, 10000n), -9999000000000);
  assert.equal(roundRatio(299n, 3n), 100);
  assert.equal(roundRatio(598n, 3n) - roundRatio(299n, 3n), 99);
  assert.equal(roundRatio(897n, 3n) - roundRatio(598n, 3n), 100);
  for (const [n, d] of [[1, 0], [1, -2], [1.5, 2], [1, 2.5], [Number.MAX_SAFE_INTEGER + 1, 2], [9007199254740992n, 1n]]) invalid(() => roundRatio(n, d));
});

test('business dates validate the calendar and retain null only when allowed', () => {
  assert.equal(businessDate('2024-02-29'), '2024-02-29');
  assert.equal(businessDate(null, 'Fecha', { nullable: true }), null);
  for (const value of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-1-01', '0000-01-01', '', null]) invalid(() => businessDate(value));
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  invalid(() => addDays('2026-01-01', 1.5));
});

test('instants require real times with explicit timezone and normalize to UTC', () => {
  assert.equal(instant('2026-11-01T00:00:00-05:00'), '2026-11-01T05:00:00.000Z');
  assert.equal(instant('2026-11-01T05:00:00.1Z'), '2026-11-01T05:00:00.100Z');
  assert.equal(instant(null, 'Instante', { nullable: true }), null);
  for (const value of ['2026-11-01', '2026-11-01T00:00:00', '2026-02-30T00:00:00Z', '2026-11-01T24:00:00Z', '2026-11-01T00:60:00Z', '2026-11-01T00:00:60Z', '2026-11-01T00:00:00+24:00', '', null]) invalid(() => instant(value));
});

test('Bogota date changes at 05 UTC, independently of the host timezone', () => {
  assert.equal(bogotaDate('2026-11-01T04:59:59Z'), '2026-10-31');
  assert.equal(bogotaDate('2026-11-01T05:00:00Z'), '2026-11-01');
  assert.equal(bogotaDate(new Date('2026-11-01T05:00:00Z')), '2026-11-01');
  assert.equal(bogotaDate(Date.parse('2026-11-01T05:00:00Z')), '2026-11-01');
  invalid(() => bogotaDate(new Date(NaN)));
  invalid(() => bogotaDate('2026-11-01'));
});

test('periods use calendar partitions, Monday weeks and exclusive Bogota boundaries', () => {
  const examples = [
    ['day', '2026-11-01', '2026-11-01', '2026-11-02'],
    ['week', '2026-01-01', '2025-12-29', '2026-01-05'],
    ['week', '2026-11-01', '2026-10-26', '2026-11-02'],
    ['week', '2026-11-02', '2026-11-02', '2026-11-09'],
    ['month', '2024-02-29', '2024-02-01', '2024-03-01'],
    ['quarter', '2026-01-15', '2026-01-01', '2026-04-01'],
    ['quarter', '2026-12-31', '2026-10-01', '2027-01-01'],
    ['halfyear', '2026-06-30', '2026-01-01', '2026-07-01'],
    ['halfyear', '2026-07-01', '2026-07-01', '2027-01-01'],
    ['year', '2026-12-31', '2026-01-01', '2027-01-01'],
  ];
  for (const [period, anchor, start, end] of examples) {
    assert.deepEqual(periodBounds(period, anchor), { startDate: start, endDateExclusive: end, startAt: `${start}T05:00:00.000Z`, endAt: `${end}T05:00:00.000Z` });
  }
  invalid(() => periodBounds('fortnight', '2026-01-01'));
  invalid(() => periodBounds('day', '2026-02-30'));
});

test('adjacent periods meet exactly, and months partition the calendar year', () => {
  for (const period of BUSINESS_PERIODS) {
    const current = periodBounds(period, '2026-07-16');
    const previous = priorPeriodBounds(period, '2026-07-16');
    const next = periodBounds(period, current.endDateExclusive);
    assert.equal(previous.endAt, current.startAt);
    assert.equal(current.endAt, next.startAt);
  }
  const year = periodBounds('year', '2026-01-01');
  let duration = 0;
  let endAt = year.startAt;
  for (let month = 1; month <= 12; month++) {
    const bounds = periodBounds('month', `2026-${String(month).padStart(2, '0')}-15`);
    assert.equal(bounds.startAt, endAt);
    duration += Date.parse(bounds.endAt) - Date.parse(bounds.startAt);
    endAt = bounds.endAt;
  }
  assert.equal(endAt, year.endAt);
  assert.equal(duration, Date.parse(year.endAt) - Date.parse(year.startAt));
  assert.equal(duration, 365 * 86400000);
});
