import test from 'node:test';
import assert from 'node:assert/strict';
import { getSlaHours, getSlaStatus } from '../../server/services/sla.js';
import { record } from '../lib/results.js';

const tierCases = [
  [100, 4], [95, 4], [90, 4], [89.99, 12], [85, 12], [80, 12], [79.99, 24], [50, 24], [0, 24],
];

test('SLA tier by confidence (0-100 scale) at boundaries', () => {
  for (const [c, h] of tierCases) assert.equal(getSlaHours(c), h, `confidence ${c}`);
});

test('SLA tier sweep 0..100 step 0.5 is monotone non-increasing', () => {
  let prev = Infinity;
  let n = 0;
  for (let c = 0; c <= 100; c += 0.5) {
    const h = getSlaHours(c);
    assert.ok(h <= prev || c === 0, `non-monotone at ${c}`);
    if (c === 0) prev = h; else prev = Math.min(prev, h);
    // higher confidence must never get a longer SLA than lower confidence
    if (c > 0) assert.ok(h <= getSlaHours(c - 0.5));
    n++;
  }
  record('sla_tiers', { boundary_cases: tierCases.length, sweep_points: n, all_pass: true });
});

test('SLA status thresholds', () => {
  assert.equal(getSlaStatus(0, 4), 'ON_TIME');
  assert.equal(getSlaStatus(3.2, 4), 'ON_TIME'); // 80% exactly is not yet at risk
  assert.equal(getSlaStatus(3.21, 4), 'AT_RISK');
  assert.equal(getSlaStatus(4, 4), 'AT_RISK'); // exactly at SLA is not yet breached
  assert.equal(getSlaStatus(4.01, 4), 'BREACHED');
});

test('documents behaviour on bad input: null/undefined/NaN/fractional confidence gets the 24h tier', () => {
  assert.equal(getSlaHours(null), 24);
  assert.equal(getSlaHours(undefined), 24);
  assert.equal(getSlaHours(NaN), 24);
  // A 0-1 fraction (e.g. 0.95) is silently treated as low confidence: the 0-100 scale is implicit.
  assert.equal(getSlaHours(0.95), 24);
});
