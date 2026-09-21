import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../lib/metrics.js';

// Correctness check of the scoring code on a hand-computed toy example.
// These are NOT detection results for InfraWatch.
test('metrics arithmetic on a toy example', () => {
  const rows = [
    { truth: true, pred: true }, { truth: true, pred: true }, { truth: true, pred: false },
    { truth: false, pred: true }, { truth: false, pred: false }, { truth: false, pred: false },
  ];
  const s = summarize(rows);
  assert.deepEqual([s.tp, s.fp, s.tn, s.fn], [2, 1, 2, 1]);
  assert.equal(s.precision, 2 / 3);
  assert.equal(s.recall, 2 / 3);
  assert.equal(s.false_positive_rate, 1 / 3);
  assert.equal(summarize([]).precision, null);
});
