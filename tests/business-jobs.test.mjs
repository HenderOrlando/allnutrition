import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, BUSINESS_PERIODS, periodBounds } from '../lib/business/dates.mjs';
import { automaticReportSchedule } from '../lib/business/jobs.mjs';

test('automatic report cursor partitions all six calendars and advances bounded pages across years', () => {
  const config = { reportsStartOn: '2025-01-01', reportPeriods: BUSINESS_PERIODS, reportGenerationTime: '06:00' };
  let cursors = {}, rotation = 0, result, count = 0;
  const keys = new Set();
  do {
    result = automaticReportSchedule(config, { now: '2026-01-01T11:00:00.000Z', cursors, rotation, maxPeriods: 7 });
    assert.ok(result.queries.length <= 7);
    for (const query of result.queries) {
      const bounds = periodBounds(query.period, query.anchorDate), key = `${query.period}:${bounds.startDate}`;
      assert.ok(!keys.has(key)); keys.add(key);
      assert.ok(bounds.startDate >= config.reportsStartOn);
      assert.ok(bounds.endDateExclusive <= '2026-01-01');
    }
    cursors = result.cursors; rotation = result.rotation; count++;
    assert.ok(count < 100);
  } while (result.hasMore);
  assert.ok(keys.has('year:2025-01-01'));
  assert.ok(keys.has('halfyear:2025-07-01'));
  assert.ok(keys.has('quarter:2025-10-01'));
  assert.ok(keys.has('month:2025-12-01'));
  assert.ok(keys.has('week:2025-12-22'));
  assert.ok(!keys.has('week:2025-12-29'));
  assert.ok(keys.has('day:2025-12-31'));
  const noNew = automaticReportSchedule(config, { now: '2026-01-02T10:59:59.000Z', cursors, rotation });
  assert.equal(noNew.queries.length, 0);
  const nextDay = automaticReportSchedule(config, { now: '2026-01-02T11:00:00.000Z', cursors, rotation });
  assert.deepEqual(nextDay.queries, [{ period: 'day', anchorDate: '2026-01-01' }]);
  assert.equal(nextDay.cursors.day, addDays('2026-01-01', 1));
});

test('September activation excludes its partial first week and waits for each completed Bogota calendar', () => {
  const config = { reportsStartOn: '2026-09-01', reportPeriods: BUSINESS_PERIODS, reportGenerationTime: '06:00' };
  let cursors = {}, rotation = 0, result;
  const beforeDeadline = [];
  do {
    result = automaticReportSchedule(config, { now: '2026-10-01T10:59:59.000Z', cursors, rotation, maxPeriods: 7 });
    beforeDeadline.push(...result.queries);
    cursors = result.cursors; rotation = result.rotation;
  } while (result.hasMore);
  assert.deepEqual(beforeDeadline.filter(query => query.period === 'day').map(query => query.anchorDate).sort(),
    Array.from({ length: 29 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(beforeDeadline.filter(query => query.period === 'week').map(query => query.anchorDate).sort(),
    ['2026-09-07', '2026-09-14', '2026-09-21']);
  assert.ok(!beforeDeadline.some(query => ['month', 'quarter', 'halfyear', 'year'].includes(query.period)));
  const atDeadline = automaticReportSchedule(config, { now: '2026-10-01T11:00:00.000Z', cursors, rotation });
  assert.deepEqual(atDeadline.queries.map(query => `${query.period}:${query.anchorDate}`).sort(),
    ['day:2026-09-30', 'month:2026-09-01']);
  const unchanged = automaticReportSchedule(config, { now: '2026-10-01T11:00:00.000Z', cursors: atDeadline.cursors, rotation: atDeadline.rotation });
  assert.deepEqual(unchanged.queries, []);
});
