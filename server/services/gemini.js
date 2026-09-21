import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { sanitizeCitations } from './citationGuard.js';

const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
const geminiKey = process.env.GEMINI_API_KEY;
const groqKey = process.env.GROQ_API_KEY;

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GEMINI_MODEL = 'gemini-2.0-flash';

console.log('[ai] Service config');
console.log('  Provider:', provider);
console.log('  Groq Key Set:', Boolean(groqKey));
console.log('  Gemini Key Set:', Boolean(geminiKey));

let genAI = null;
let groqClient = null;

try {
  if (provider === 'gemini' && geminiKey) {
    genAI = new GoogleGenerativeAI(geminiKey);
    console.log('[ai] Gemini client initialized');
  } else if (provider === 'groq' && groqKey) {
    groqClient = new Groq({ apiKey: groqKey });
    console.log('[ai] Groq client initialized');
  } else {
    console.warn('[ai] No usable AI provider configured', {
      provider,
      hasGroq: Boolean(groqKey),
      hasGemini: Boolean(geminiKey),
    });
  }
} catch (error) {
  console.error('[ai] Failed to initialize AI client:', error.message);
}

if (!geminiKey && !groqKey) {
  console.warn('[ai] No AI API keys set. Configure GEMINI_API_KEY or GROQ_API_KEY.');
}

console.log(`[ai] Using provider: ${provider.toUpperCase()}`);

export async function generateAINotice(violation, templateContent = null) {
  if (provider === 'groq') {
    return generateWithGroq(violation, templateContent);
  }

  if (provider === 'gemini') {
    return generateWithGemini(violation, templateContent);
  }

  throw new Error(`Unknown AI provider: ${provider}`);
}

const ALLOWED_VIOLATION_TYPES = [
  'Unauthorized Floor Addition',
  'No Building Permit',
  'Encroachment on Public Land',
  'Commercial Use in Residential Zone',
  'Setback Violation',
  'Illegal Basement Construction',
];

const REVIEW_ACTION_CODES = [
  'confirm_violation',
  'needs_field_inspection',
  'generate_legal_notice',
  'mark_false_positive',
];

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

async function generateWithGroq(violation, templateContent = null) {
  if (!groqKey) {
    throw new Error('Groq API key not configured. Set GROQ_API_KEY environment variable.');
  }

  try {
    if (!groqClient) {
      groqClient = new Groq({ apiKey: groqKey });
    }

    const prompt = buildPrompt(violation, templateContent);

    console.log(`[ai] Calling Groq API with model: ${GROQ_MODEL}`);

    const completion = await groqClient.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.35,
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content:
            'You are a senior BBMP legal draftsman for Bengaluru municipal enforcement. You cite only from: Karnataka Municipal Corporations Act 1976 (Sec 308, 321, 322), BBMP Building Bye-laws 2003, and Karnataka Town & Country Planning Act 1961. If unsure of a section number, say "Refer to applicable BBMP Building Bye-laws, 2003" instead of inventing it. Produce formal English notices ready for officer review. Follow the structure exactly as instructed in the user prompt.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const text = completion.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new Error('Groq returned an empty notice draft.');
    }

    console.log('[ai] Groq response received');

    const guarded = sanitizeCitations(text);
    return {
      success: true,
      content: guarded.text,
      citationsRemoved: guarded.removed,
      model: GROQ_MODEL,
      provider: 'groq',
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[ai] Groq API error:', error.message);
    throw new Error(`Failed to generate AI notice with Groq: ${error.message}`);
  }
}

async function generateWithGemini(violation, templateContent = null) {
  if (!genAI || !geminiKey) {
    throw new Error('Gemini API key not configured. Set GEMINI_API_KEY environment variable.');
  }

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const prompt = buildPrompt(violation, templateContent);
    const result = await model.generateContent(prompt);
    const text = result.response.text()?.trim();

    if (!text) {
      throw new Error('Gemini returned an empty notice draft.');
    }

    const guarded = sanitizeCitations(text);
    return {
      success: true,
      content: guarded.text,
      citationsRemoved: guarded.removed,
      model: GEMINI_MODEL,
      provider: 'gemini',
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[ai] Gemini API error:', error.message);
    throw new Error(`Failed to generate AI notice with Gemini: ${error.message}`);
  }
}

function buildPrompt(violation, templateContent) {
  const baseTemplate =
    templateContent ||
    `NOTICE OF ILLEGAL CONSTRUCTION

Ref No.: {violation_id}
Date: {date}

To: {owner_name}
{address}

Violation Type: {type}
Survey No: {survey_no}
Zone: {zone}
Last Approved Plan: {last_approved_year}
Unauthorized Area: ~{area} sq ft
Detection Confidence: {confidence}%

The BBMP has detected unauthorized construction on your property.

Directives:
1. Stop all construction immediately
2. Submit valid permit within 7 days
3. Appear for personal hearing

Penalty up to Rs {penalty}L under BBMP Act Sec 321

Issued by: {officer_name}
BBMP {ward} Ward`;

  const today = new Date().toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  const filledTemplate = baseTemplate
    .replace('{violation_id}', violation.id || 'N/A')
    .replace('{date}', today)
    .replace('{owner_name}', violation.owner_name || 'Property Owner')
    .replace('{address}', violation.address || 'Location not specified')
    .replace('{type}', violation.type || 'Unauthorized Construction')
    .replace('{survey_no}', violation.survey_no || 'N/A')
    .replace('{zone}', violation.zone || 'N/A')
    .replace('{last_approved_year}', violation.last_approved_year || 'N/A')
    .replace('{area}', violation.area || '0')
    .replace('{confidence}', violation.confidence || '0')
    .replace('{penalty}', violation.penalty || '0')
    .replace('{officer_name}', violation.officer_name || 'BBMP Official')
    .replace('{ward}', violation.ward || 'Bengaluru');

  return `You are a senior BBMP legal draftsman generating a formal municipal enforcement notice for unauthorized construction in Bengaluru, Karnataka, India.

═══════ APPLICABLE LEGAL FRAMEWORK ═══════
You MUST cite only from these Indian statutes (do not invent sections):

1. KARNATAKA MUNICIPAL CORPORATIONS ACT, 1976
   • Section 308 — Building without sanctioned plan / deviation from plan
   • Section 321 — Power to demolish; monetary penalty
   • Section 322 — Stop-work notice for ongoing unauthorized construction
   • Section 321A — Compounding fee provisions (where permissible)

2. BBMP BUILDING BYE-LAWS, 2003
   • Bye-law 2.2 — Setback requirements by plot size
   • Bye-law 2.5 — Floor Area Ratio (FAR) and height
   • Bye-law 3.0 — Change of land use / occupancy
   • Bye-law 4.6 — Mandatory approval before commencement

3. KARNATAKA TOWN AND COUNTRY PLANNING ACT, 1961
   • Section 14 — Planning authority control over development
   • Section 15 — Penalty for unauthorized development
   • Section 76-FF — Offences & prosecution

═══════ ANTI-HALLUCINATION GUARDRAIL ═══════
If you do not have enough information to cite a specific section with confidence,
say "Refer to applicable BBMP Building Bye-laws, 2003" instead of inventing a section number.
Never cite case law or statutes not listed above.

═══════ CASE DATA ═══════
Violation ID: ${violation.id}
Type: ${violation.type}
Address: ${violation.address}
Survey Number: ${violation.survey_no}
Zone: ${violation.zone}
Detected: ${violation.detected_date}
AI Confidence: ${violation.confidence}%
Area: ${violation.area} sq.ft
Height Delta: ${violation.height_delta} m
Last Approved Year: ${violation.last_approved_year}
Owner: ${violation.owner_name}
Ward: ${violation.ward}
Penalty Estimate: Rs ${violation.penalty} lakh

═══════ REQUIRED NOTICE STRUCTURE ═══════
Produce a formal English notice (Kannada translation can be generated later via a /translate flow) using exactly this structure:

NOTICE NUMBER: [BBMP/INFRAWATCH/YYYY/MM/####]
DATE: [today's date in formal Indian English]
TO: [owner name], [property address]
PROPERTY ADDRESS: [full address with ward + pincode]
NATURE OF VIOLATION: [2-3 sentences citing evidence]
LEGAL PROVISIONS CITED: [list specific sections from framework above]
REQUIRED ACTION: [numbered list]
COMPLIANCE DEADLINE: [today + 7/15/30 days based on severity]
CONSEQUENCES OF NON-COMPLIANCE: [cite specific sections]
ISSUING OFFICER: [e.g. "Assistant Executive Engineer, BBMP ${violation.ward} Ward"]

Use formal Indian-English legalese. Be specific, not generic.

Reference template structure:
${filledTemplate}

Return only the final notice text.`;
}

export async function analyzeSatelliteImagery({ violation, beforeImage, afterImage }) {
  const client = getGeminiClient();
  const model = client.getGenerativeModel({ model: GEMINI_MODEL });

  const parts = [
    buildSatelliteClassificationPrompt(violation),
  ];

  if (beforeImage?.dataUrl) {
    parts.push(dataUrlToInlinePart(beforeImage.dataUrl));
  }

  if (afterImage?.dataUrl) {
    parts.push(dataUrlToInlinePart(afterImage.dataUrl));
  }

  const result = await model.generateContent(parts);
  const text = result.response.text()?.trim();

  if (!text) {
    throw new Error('Gemini returned an empty satellite analysis.');
  }

  const parsed = parseSatelliteAnalysis(text);

  return {
    provider: 'gemini',
    model: GEMINI_MODEL,
    rawResponse: text,
    predictedType: parsed.predictedType,
    confidence: parsed.confidence,
    changeDetected: parsed.changeDetected,
    summary: parsed.summary,
    rationale: parsed.rationale,
    recommendedAction: parsed.recommendedAction,
    evidencePoints: parsed.evidencePoints,
  };
}

export async function generateCaseReviewDossier(caseContext) {
  const prompt = buildCaseReviewPrompt(caseContext);
  const systemPrompt =
    'You are INFRAWATCH Copilot, a municipal enforcement adjudication assistant. Return strict JSON only. Ground every conclusion in the supplied case facts, permit record, review history, and officer notes.';

  const providersToTry = provider === 'gemini'
    ? ['gemini', ...(groqKey ? ['groq'] : [])]
    : provider === 'groq'
      ? ['groq', ...(geminiKey ? ['gemini'] : [])]
      : ['gemini', 'groq'];

  let lastError = null;

  for (const providerName of providersToTry) {
    try {
      const response = await runProviderText(providerName, { prompt, systemPrompt, temperature: 0.2, maxTokens: 1800 });
      const parsed = parseCaseReviewDossier(response.content);

      return {
        provider: response.provider,
        model: response.model,
        rawResponse: response.content,
        confidence: parsed.confidence,
        riskLevel: parsed.riskLevel,
        recommendationCode: parsed.recommendationCode,
        executiveSummary: parsed.executiveSummary,
        whyFlagged: parsed.whyFlagged,
        legalBasis: parsed.legalBasis,
        permitAnalysis: parsed.permitAnalysis,
        actionReason: parsed.actionReason,
        evidenceGaps: parsed.evidenceGaps,
        inspectionChecklist: parsed.inspectionChecklist,
        noticeStrategy: parsed.noticeStrategy,
        commissionerBrief: parsed.commissionerBrief,
      };
    } catch (error) {
      lastError = error;
      console.error(`[ai] Case review generation failed with ${providerName}:`, error.message);
    }
  }

  throw new Error(lastError?.message || 'AI case review generation failed.');
}

function getGeminiClient() {
  if (genAI) {
    return genAI;
  }

  if (!geminiKey) {
    throw new Error('Gemini API key not configured. Set GEMINI_API_KEY for imagery classification.');
  }

  genAI = new GoogleGenerativeAI(geminiKey);
  return genAI;
}

async function runProviderText(providerName, { prompt, systemPrompt, temperature = 0.2, maxTokens = 1200 }) {
  if (providerName === 'groq') {
    if (!groqKey) {
      throw new Error('Groq API key not configured.');
    }

    if (!groqClient) {
      groqClient = new Groq({ apiKey: groqKey });
    }

    const completion = await groqClient.chat.completions.create({
      model: GROQ_MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Groq returned an empty response.');
    }

    return {
      provider: 'groq',
      model: GROQ_MODEL,
      content: text,
    };
  }

  if (providerName === 'gemini') {
    const client = getGeminiClient();
    const model = client.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(`${systemPrompt}\n\n${prompt}`);
    const text = result.response.text()?.trim();

    if (!text) {
      throw new Error('Gemini returned an empty response.');
    }

    return {
      provider: 'gemini',
      model: GEMINI_MODEL,
      content: text,
    };
  }

  throw new Error(`Unsupported provider: ${providerName}`);
}

function buildSatelliteClassificationPrompt(violation) {
  return `You are an urban imagery analyst helping BBMP review suspected illegal construction from before/after satellite or aerial images.

Case context:
- Violation ID: ${violation.id}
- Current seeded type: ${violation.type}
- Ward: ${violation.ward}
- Address: ${violation.address}
- Survey number: ${violation.survey_no || 'Unknown'}
- Zone: ${violation.zone || 'Unknown'}
- Last approved plan year: ${violation.last_approved_year || 'Unknown'}

Classify the most likely violation type from this allowed list only:
${ALLOWED_VIOLATION_TYPES.map((item) => `- ${item}`).join('\n')}

Instructions:
1. Compare the before and after images if both are provided.
2. Focus on visible structural change, footprint encroachment, vertical expansion, basement excavation cues, and land-use signals.
3. If the evidence is weak or ambiguous, lower the confidence and recommend field inspection.
4. Never invent facts that are not visually supported.
5. Return strict JSON only with no markdown fences.

JSON schema:
{
  "predictedType": "one of the allowed labels",
  "confidence": 0-100 integer,
  "changeDetected": true,
  "summary": "short 1-2 sentence explanation of the visible change",
  "rationale": "why this violation label best matches the imagery and case context",
  "recommendedAction": "Confirm Violation" | "Needs Field Inspection" | "Mark False Positive",
  "evidencePoints": ["bullet 1", "bullet 2", "bullet 3"]
}`;
}

function buildCaseReviewPrompt(caseContext) {
  return `Review this INFRAWATCH violation and produce a grounded municipal enforcement dossier.

Case facts:
${JSON.stringify({
    violation: caseContext.violation,
    permitCheck: caseContext.permitCheck,
    recentNotes: caseContext.recentNotes,
    latestFeedback: caseContext.latestFeedback,
    latestNotice: caseContext.latestNotice,
    latestImageAnalysis: caseContext.latestImageAnalysis,
  }, null, 2)}

You must decide the single best next action from:
${REVIEW_ACTION_CODES.map((item) => `- ${item}`).join('\n')}

Requirements:
1. Explain why the case is suspicious using only the supplied facts.
2. Reference likely legal or regulatory basis in practical enforcement language.
3. Cross-check the permit history and mismatch reasoning.
4. Identify evidence gaps before strong action is taken.
5. Provide a field inspection checklist if inspection is needed.
6. Provide a notice strategy if legal notice is recommended.
7. Write a short commissioner-ready summary.
8. Return strict JSON only with no markdown fences.

JSON schema:
{
  "confidence": 0-100,
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "recommendationCode": "confirm_violation" | "needs_field_inspection" | "generate_legal_notice" | "mark_false_positive",
  "executiveSummary": "2-3 sentence executive summary",
  "whyFlagged": "clear explanation of why the case appears suspicious",
  "legalBasis": ["short legal/regulatory bullets"],
  "permitAnalysis": "permit mismatch analysis grounded in case data",
  "actionReason": "why the recommendation is the best next action",
  "evidenceGaps": ["missing evidence or uncertainty items"],
  "inspectionChecklist": ["specific field inspection steps"],
  "noticeStrategy": "how a notice should be framed if escalation is needed",
  "commissionerBrief": "short command-level brief"
}`;
}

function dataUrlToInlinePart(dataUrl) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    throw new Error('Image upload must be a valid data URL.');
  }

  return {
    inlineData: {
      mimeType: match[1],
      data: match[2],
    },
  };
}

function parseSatelliteAnalysis(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const objectText = extractJsonObject(cleaned);
  let parsed;

  try {
    parsed = JSON.parse(objectText);
  } catch {
    throw new Error('AI imagery classification returned invalid JSON.');
  }

  const predictedType = ALLOWED_VIOLATION_TYPES.includes(parsed.predictedType)
    ? parsed.predictedType
    : 'Unauthorized Floor Addition';

  const confidence = Math.max(1, Math.min(99, Number(parsed.confidence) || 0));
  const evidencePoints = Array.isArray(parsed.evidencePoints)
    ? parsed.evidencePoints.filter(Boolean).slice(0, 4)
    : [];
  const recommendedAction = ['Confirm Violation', 'Needs Field Inspection', 'Mark False Positive'].includes(parsed.recommendedAction)
    ? parsed.recommendedAction
    : 'Needs Field Inspection';

  return {
    predictedType,
    confidence,
    changeDetected: Boolean(parsed.changeDetected),
    summary: String(parsed.summary || 'AI analysis completed, but no concise summary was returned.'),
    rationale: String(parsed.rationale || 'Gemini reviewed the supplied imagery and selected the closest matching violation label.'),
    recommendedAction,
    evidencePoints,
  };
}

function parseCaseReviewDossier(rawText) {
  const objectText = extractJsonObject(
    rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
  );

  let parsed;

  try {
    parsed = JSON.parse(objectText);
  } catch {
    throw new Error('AI case review returned invalid JSON.');
  }

  const recommendationCode = REVIEW_ACTION_CODES.includes(parsed.recommendationCode)
    ? parsed.recommendationCode
    : 'needs_field_inspection';
  const riskLevel = RISK_LEVELS.includes(parsed.riskLevel)
    ? parsed.riskLevel
    : 'MEDIUM';

  return {
    confidence: Math.max(1, Math.min(99, Number(parsed.confidence) || 0)),
    riskLevel,
    recommendationCode,
    executiveSummary: String(parsed.executiveSummary || 'AI review completed, but no executive summary was returned.'),
    whyFlagged: String(parsed.whyFlagged || 'The supplied case facts indicate a likely enforcement issue that should be reviewed by an officer.'),
    legalBasis: Array.isArray(parsed.legalBasis) ? parsed.legalBasis.filter(Boolean).slice(0, 5) : [],
    permitAnalysis: String(parsed.permitAnalysis || 'Permit alignment could not be fully assessed from the returned review.'),
    actionReason: String(parsed.actionReason || 'This recommendation best matches the current evidence confidence and enforcement posture.'),
    evidenceGaps: Array.isArray(parsed.evidenceGaps) ? parsed.evidenceGaps.filter(Boolean).slice(0, 5) : [],
    inspectionChecklist: Array.isArray(parsed.inspectionChecklist) ? parsed.inspectionChecklist.filter(Boolean).slice(0, 6) : [],
    noticeStrategy: String(parsed.noticeStrategy || 'Escalate only after officer confirmation and permit mismatch review.'),
    commissionerBrief: String(parsed.commissionerBrief || 'AI review completed for command-level visibility.'),
  };
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI imagery classification did not return a JSON object.');
  }

  return text.slice(start, end + 1);
}

export async function validateAPIKey() {
  if (provider === 'groq') {
    if (!groqKey) {
      return {
        isValid: false,
        message: 'GROQ_API_KEY environment variable not set',
        provider: 'groq',
      };
    }

    return {
      isValid: true,
      message: 'Groq API key is set and ready',
      provider: 'groq',
    };
  }

  if (provider === 'gemini') {
    if (!geminiKey) {
      return {
        isValid: false,
        message: 'GEMINI_API_KEY environment variable not set',
        provider: 'gemini',
      };
    }

    return {
      isValid: true,
      message: 'Gemini API key is set and ready',
      provider: 'gemini',
    };
  }

  return {
    isValid: false,
    message: `Unknown provider: ${provider}. Set AI_PROVIDER to 'groq' or 'gemini'.`,
    provider,
  };
}
