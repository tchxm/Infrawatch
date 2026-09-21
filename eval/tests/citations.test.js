import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateCitations } from '../lib/citations.js';
import { record } from '../lib/results.js';

const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/citations.json', import.meta.url)));

test('reference validator: catch rate on fabricated, false-positive rate on valid', () => {
  const missed = fx.fabricated.filter((t) => validateCitations(t).ok);
  const falsePos = fx.valid.filter((t) => !validateCitations(t).ok);
  record('citation_validator', {
    fabricated_n: fx.fabricated.length,
    caught: fx.fabricated.length - missed.length,
    catch_rate: (fx.fabricated.length - missed.length) / fx.fabricated.length,
    valid_n: fx.valid.length,
    false_positives: falsePos.length,
    false_positive_rate: falsePos.length / fx.valid.length,
    missed,
    false_positive_examples: falsePos,
  });
  assert.equal(missed.length, 0, `missed: ${JSON.stringify(missed)}`);
  assert.equal(falsePos.length, 0, `false positives: ${JSON.stringify(falsePos)}`);
});
