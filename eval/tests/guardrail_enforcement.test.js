/**
 * Measures what the APP ITSELF does when the model returns a notice with a fabricated
 * citation: runs the real generateLegalNoticeFromAnalysis with a stubbed provider.
 * Before the server-side citation guard existed this passed 20/20 fabrications through
 * unchanged (0% catch rate). The guard now strips them; this test tracks the catch rate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { record } from '../lib/results.js';
import { validateCitations } from '../../server/services/citationGuard.js';

process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'dummy-groq';
delete process.env.GEMINI_API_KEY;
const { generateLegalNoticeFromAnalysis } = await import('../../server/services/visionAI.js');

const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/citations.json', import.meta.url)));
const realFetch = globalThis.fetch;
let current;
globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    noticeType: 'Show Cause',
    noticeContent: `LEGAL PROVISIONS CITED: ${current}`,
    legalSectionsCited: [current],
  }) } }],
}), { status: 200 });

test.after(() => { globalThis.fetch = realFetch; });

test('app strips fabricated citations before returning the notice', async () => {
  const violation = { id: '#IW-9999', owner_name: 'Test', address: 'x', ward: 'Ward 1' };
  const analysis = { primaryViolationType: 'Unauthorized Floor Addition', overallConfidence: 90, riskLevel: 'HIGH', totalEstimatedAreaSqFt: 100, visualEvidence: [] };
  const penalty = { calculatedPenaltyINR: 1, calculatedPenaltyLakhs: 1, legalBasis: 'x', formula: 'x' };
  let passedThrough = 0;
  let flaggedByRef = 0;
  for (const fab of fx.fabricated) {
    current = fab;
    const out = await generateLegalNoticeFromAnalysis({ violation, analysisResult: analysis, penaltyCalculation: penalty });
    if (out.noticeContent.includes(fab)) passedThrough++;
    if (!validateCitations(out.noticeContent).ok) flaggedByRef++;
  }
  record('app_guardrail_enforcement', {
    fabricated_n: fx.fabricated.length,
    app_returned_fabricated_text_unchanged: passedThrough,
    app_side_catch_rate: 1 - passedThrough / fx.fabricated.length,
    still_flagged_by_validator_after_guard: flaggedByRef,
  });
  assert.equal(passedThrough, 0);
  assert.equal(flaggedByRef, 0);
});
