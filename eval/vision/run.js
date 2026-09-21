/**
 * Vision detection eval (REQUIRES labeled imagery + a real API key; makes paid/quota-limited calls).
 *
 *   1. Put images in eval/vision/images/ and describe them in eval/vision/labels.csv
 *      (see labels.template.csv).
 *   2. export GEMINI_API_KEY=... (and optionally GROQ_API_KEY=...) ; AI_PROVIDER=gemini
 *   3. node eval/vision/run.js [--limit N]
 *
 * It calls the same analyzeSingleImage() the app uses (bypassing the seeded-demo shortcut in
 * routes/vision.js) and scores the binary decision `suspiciousAreasDetected` against your label.
 * Output: eval/results/vision.json. If no labels/keys are present it exits without writing numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../lib/metrics.js';
import { record } from '../lib/results.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const labelsPath = path.join(here, 'labels.csv');

if (!fs.existsSync(labelsPath)) {
  console.log('No eval/vision/labels.csv found. Copy labels.template.csv, add labeled images. Results: PENDING (no data).');
  process.exit(0);
}
if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
  console.log('No GEMINI_API_KEY / GROQ_API_KEY set. Results: PENDING (no key).');
  process.exit(0);
}

const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
const { analyzeSingleImage } = await import('../../server/services/visionAI.js');

const lines = fs.readFileSync(labelsPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
const header = lines.shift().split(',').map((s) => s.trim());
const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [header[i], v.trim()]))).slice(0, limit);

const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const scored = [];
const errors = [];
for (const r of rows) {
  const file = path.join(here, 'images', r.image);
  try {
    const dataUrl = `data:${mime[path.extname(file).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
    const out = await analyzeSingleImage({ image: { dataUrl }, locationContext: { address: r.image, zone: 'Residential' } });
    scored.push({ image: r.image, truth: r.has_violation === '1', pred: Boolean(out.suspiciousAreasDetected), confidence: out.overallConfidence ?? null });
  } catch (e) {
    errors.push({ image: r.image, error: String(e.message).slice(0, 200) });
  }
}

record('vision', {
  status: 'measured',
  provider: process.env.AI_PROVIDER || 'gemini',
  model: process.env.GEMINI_MODEL || null,
  run_at: new Date().toISOString(),
  metrics: summarize(scored),
  errors,
  per_image: scored,
});
