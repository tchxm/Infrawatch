# InfraWatch evaluation harness

A small, reproducible harness that measures the parts of InfraWatch that can be measured **without paid API calls or labeled imagery**, and provides a ready-to-run harness for the part that cannot (vision accuracy).

## Run

```bash
cd server && npm install && cd ..     # the failover test imports the real server code
cd eval && npm test                   # or from repo root: node --test "eval/tests/*.test.js"
```

No API keys, network, or database are needed. Each test writes its numbers to `eval/results/*.json`. Last run: 14 tests, 14 pass (Node 22).

## What is measured, and what it means

### 1. SLA tier routing (`tests/sla.test.js`, real code)
The confidence-to-SLA mapping used by the crisis feed (`server/routes/violations.js`) was extracted verbatim into `server/services/sla.js` (behaviour-preserving) so it can be tested.

| Check | Result |
|---|---|
| 9 boundary confidences (100, 95, 90, 89.99, 85, 80, 79.99, 50, 0) map to 4h / 12h / 24h as documented | 9/9 |
| Sweep 0-100 in steps of 0.5 (201 points): higher confidence never gets a longer SLA | pass |
| Status thresholds: ON_TIME up to 80% of SLA, AT_RISK up to 100%, BREACHED beyond | pass |

Observed edge behaviour (documented, not judged): `null`, `undefined`, `NaN`, and a 0-1 fraction such as `0.95` all fall into the 24h tier, because the 0-100 scale is implicit. Also note the crisis feed's candidate filter uses `confidence >= 85` while the 4h tier starts at 90 (`violations.js`), so 85-89 cases are listed but get the 12h SLA.

### 2. AI provider failover (`tests/failover.test.js`, real code, stubbed network)
Runs the real dispatcher in `server/services/visionAI.js` with dummy keys and a stubbed `fetch` (the Gemini SDK and the Groq call both go through `fetch`). 7 scenarios:

| Scenario | Outcome observed |
|---|---|
| Gemini healthy | Gemini answers, Groq called 0 times |
| Gemini 429 | falls over, Groq answers (1 call) |
| Gemini 503 | falls over, Groq answers |
| Gemini hangs past timeout (300 ms in test; 30 s default) | falls over, Groq answers |
| Gemini 400 (non-retryable) | no failover, error surfaced |
| Both fail with 429 | error `Both AI providers unavailable...` |
| 429 with no Groq key configured | no failover, error surfaced |

Finding: after a failover, the parsed result's `_provider`/`_model` metadata still reports `gemini` (it is read from config in `parseVisionResponse`, not from the provider that actually answered). The dispatcher itself returns the correct provider; the metadata attached to the parsed payload does not. Scope: only the `callAI` path in `visionAI.js` fails over. `generateAINotice` in `services/gemini.js` (the `/api/notices/generate-ai` route) uses a single provider chosen by `AI_PROVIDER` (default `groq` in that file) with no failover.

### 3. Citation guardrail (`tests/citations.test.js`, `tests/guardrail_enforcement.test.js`)
Two different questions, deliberately separated:

**a) Does the app catch fabricated citations in code?** Originally the guardrail was a **prompt instruction only**, and with a stubbed provider returning 20 notices that cite fabricated provisions the real function returned the fabricated text unchanged in **20 of 20** cases (catch rate **0%**). That prompted `server/services/citationGuard.js`, now called from `visionAI.js` and `gemini.js`. Re-running the same test, the app removes the fabricated citation in **20 of 20** cases (catch rate **100%**).

**b) What would a deterministic post-check against the same allowlist catch?** `server/services/citationGuard.js` is the validator, now enforced in the app. Allowlist = the sections named in the app's own prompt (KMC Act 1976 s.308/321/321A/322; Bye-laws 2003 2.2/2.5/3.0/4.6; KTCP Act 1961 s.14/15/76-FF). On 20 hand-written fabricated snippets (non-existent sections, wrong-Act sections, IPC/Constitution/case-law citations, a fake statute, a real-looking fallback phrase followed by a fabricated section) and 20 valid snippets: **20/20 caught (100%), 0/20 false positives**.

Caveats: the fixtures are synthetic and written by the same author as the validator, so 100% is a sanity check, not a generalisation claim. The allowlist comes from the app's prompt and has **not** been verified against the statutes. Neither result says anything about how often a real LLM hallucinates a citation; that needs a live run (see below).

### 4. Vision detection accuracy: PENDING
Not measured. It needs human-labeled satellite tiles and a Gemini or Groq key. No accuracy numbers are reported anywhere in this repo.

To run once you have data:
1. Copy `vision/labels.template.csv` to `vision/labels.csv`; add images under `vision/images/`; set `has_violation` to 1/0 from human ground truth (aim for a balanced set, e.g. 50/50).
2. `export GEMINI_API_KEY=...` (optionally `GROQ_API_KEY`), then `node eval/vision/run.js --limit 100`.
3. Output `eval/results/vision.json`: confusion matrix, precision, recall, F1, false-positive rate, per-image predictions.

The harness calls `analyzeSingleImage` directly, bypassing the seeded demo detections in `routes/vision.js`. Expect a false-positive bias worth measuring: that prompt tells the model to flag at least one suspicious area whenever buildings are visible. The metric code itself is unit-tested on a toy example (`tests/metrics.test.js`), which is not a detection result.

## Not covered
Auth/RBAC, notice generation quality, penalty formula correctness, officer assignment, and the client. The README's "round-robin" officer assignment claim could not be found in server code (see the main README).
