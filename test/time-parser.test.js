import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, calculateWaitMs } from '../src/time-parser.js';

const HOUR = 3_600_000;

test('parses absolute time with timezone', () => {
  assert.deepEqual(parseResetTime('resets 3pm (UTC)'), { hour: 15, minute: 0, timezone: 'UTC', ambiguous: false });
});

test('parses minutes and named timezone (#19 example)', () => {
  assert.deepEqual(parseResetTime('· resets 6:50pm (Europe/London)'), {
    hour: 18,
    minute: 50,
    timezone: 'Europe/London',
    ambiguous: false,
  });
});

test('parses 12am / 12pm correctly', () => {
  assert.equal(parseResetTime('resets 12am (UTC)').hour, 0);
  assert.equal(parseResetTime('resets 12pm (UTC)').hour, 12);
});

test('parses relative time', () => {
  assert.deepEqual(parseResetTime('try again in 5 minutes'), { relative: true, waitMs: 5 * 60_000 });
});

test('relative wait adds the margin', () => {
  const ms = calculateWaitMs({ relative: true, waitMs: 5 * 60_000 }, 60);
  assert.equal(ms, 5 * 60_000 + 60_000);
});

// Issue #6 / #9 / #4: east-of-UTC zones must NOT over-wait by ~24h.
test('Asia/Tokyo reset later the same day is ~10h, not ~25h (#6)', () => {
  // now = 2026-04-15 09:43 JST (00:43 UTC). Reset 8pm JST = 11:00 UTC same day.
  const now = new Date('2026-04-15T00:43:00Z');
  const parsed = parseResetTime('resets 8pm (Asia/Tokyo)');
  const ms = calculateWaitMs(parsed, 60, 5, now);
  const hours = ms / HOUR;
  assert.ok(hours > 10 && hours < 11, `expected ~10.3h, got ${hours.toFixed(2)}h`);
});

test('Europe/Warsaw (UTC+2) evening reset stays same-day (#4)', () => {
  // now = 2026-07-01 18:00 Warsaw (16:00 UTC). Reset 10pm Warsaw = 20:00 UTC.
  const now = new Date('2026-07-01T16:00:00Z');
  const parsed = parseResetTime('resets 10pm (Europe/Warsaw)');
  const ms = calculateWaitMs(parsed, 0, 5, now);
  const hours = ms / HOUR;
  assert.ok(hours > 3.9 && hours < 4.1, `expected ~4h, got ${hours.toFixed(2)}h`);
});

test('reset time already passed today rolls to tomorrow', () => {
  // now = 2026-04-15 21:00 UTC. Reset 8am UTC already passed -> tomorrow 8am.
  const now = new Date('2026-04-15T21:00:00Z');
  const parsed = parseResetTime('resets 8am (UTC)');
  const ms = calculateWaitMs(parsed, 0, 5, now);
  const hours = ms / HOUR;
  assert.ok(hours > 10.9 && hours < 11.1, `expected ~11h, got ${hours.toFixed(2)}h`);
});

test('ambiguous time (no am/pm) picks the soonest future occurrence', () => {
  // now = 10:00 UTC, "resets 3" -> 15:00 today (5h) beats 03:00 tomorrow (17h).
  const now = new Date('2026-04-15T10:00:00Z');
  const parsed = parseResetTime('resets 3 (UTC)');
  assert.equal(parsed.ambiguous, true);
  const hours = calculateWaitMs(parsed, 0, 5, now) / HOUR;
  assert.ok(hours > 4.9 && hours < 5.1, `expected ~5h, got ${hours.toFixed(2)}h`);
});

test('unparseable reset falls back to fallbackHours', () => {
  const ms = calculateWaitMs(null, 60, 5);
  assert.equal(ms, (5 * 3600 + 60) * 1000);
});

test('garbled timezone falls back instead of throwing', () => {
  const ms = calculateWaitMs({ hour: 15, minute: 0, timezone: 'Not/AZone', ambiguous: false }, 60, 5);
  assert.equal(ms, (5 * 3600 + 60) * 1000);
});
