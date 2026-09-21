/**
 * Failover eval: runs the REAL dispatcher (server/services/visionAI.js callAI, reached via the
 * exported analyzeSingleImage) with dummy API keys and a stubbed global fetch. No network, no cost.
 * The stub stands in for both the Gemini SDK (which uses fetch) and Groq (raw fetch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../lib/results.js';

process.env.AI_TIMEOUT_MS = '300';
process.env.GEMINI_API_KEY = 'dummy-gemini';
process.env.GROQ_API_KEY = 'dummy-groq';
process.env.AI_PROVIDER = 'gemini';
const { analyzeSingleImage } = await import('../../server/services/visionAI.js');

const GOOD = JSON.stringify({ suspiciousAreasDetected: true, totalAreas: 1, detections: [], overallConfidence: 80 });
const realFetch = globalThis.fetch;
let calls;

function stub({ gemini, groq }) {
  calls = { gemini: 0, groq: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const which = u.includes('generativelanguage') ? 'gemini' : u.includes('groq.com') ? 'groq' : null;
    if (!which) throw new Error('unexpected fetch ' + u);
    calls[which]++;
    const beh = which === 'gemini' ? gemini : groq;
    if (beh === 'hang') return new Promise(() => {});
    if (typeof beh === 'number' && beh !== 200) {
      return new Response(JSON.stringify({ error: { message: `HTTP ${beh}` } }), { status: beh });
    }
    const body = which === 'gemini'
      ? { candidates: [{ content: { parts: [{ text: GOOD }], role: 'model' }, finishReason: 'STOP' }] }
      : { choices: [{ message: { content: GOOD } }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const scenarios = [];
async function scenario(name, cfg) {
  stub(cfg);
  let outcome;
  try {
    const r = await analyzeSingleImage({ image: null, locationContext: {} });
    outcome = { ok: true, provider_reported: r._provider, calls: { ...calls } };
  } catch (e) {
    outcome = { ok: false, error: String(e.message).slice(0, 160), calls: { ...calls } };
  }
  scenarios.push({ name, ...outcome });
  return outcome;
}

test.after(() => {
  globalThis.fetch = realFetch;
  record('failover', { scenarios });
});

test('primary healthy: Gemini answers, Groq never called', async () => {
  const o = await scenario('primary_ok', { gemini: 200, groq: 200 });
  assert.ok(o.ok, JSON.stringify(o));
  assert.equal(o.calls.groq, 0);
  assert.equal(o.calls.gemini, 1);
});
test('Gemini 429 -> Groq answers', async () => {
  const o = await scenario('gemini_429', { gemini: 429, groq: 200 });
  assert.ok(o.ok, JSON.stringify(o));
  assert.equal(o.calls.groq, 1);
});
test('Gemini 503 -> Groq answers', async () => {
  const o = await scenario('gemini_503', { gemini: 503, groq: 200 });
  assert.ok(o.ok, JSON.stringify(o));
  assert.equal(o.calls.groq, 1);
});
test('Gemini hangs past timeout -> Groq answers', async () => {
  const o = await scenario('gemini_timeout', { gemini: 'hang', groq: 200 });
  assert.ok(o.ok, JSON.stringify(o));
  assert.equal(o.calls.groq, 1);
});
test('Gemini 400 (non-retryable): no failover, error surfaces', async () => {
  const o = await scenario('gemini_400', { gemini: 400, groq: 200 });
  assert.equal(o.ok, false);
  assert.equal(o.calls.groq, 0);
});
test('both providers fail: combined error', async () => {
  const o = await scenario('both_fail', { gemini: 429, groq: 429 });
  assert.equal(o.ok, false);
  assert.match(o.error, /Both AI providers unavailable/);
});
test('no Groq key: no failover even on 429', async () => {
  const k = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const o = await scenario('no_secondary_key', { gemini: 429, groq: 200 });
    assert.equal(o.ok, false);
    assert.equal(o.calls.groq, 0);
  } finally {
    process.env.GROQ_API_KEY = k;
  }
});
