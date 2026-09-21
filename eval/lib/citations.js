/**
 * Reference citation validator used by the eval.
 *
 * IMPORTANT: this is NOT part of the InfraWatch runtime. The app's only
 * anti-hallucination guard today is a prompt instruction (see
 * server/services/visionAI.js, generateLegalNoticeFromAnalysis, and
 * server/services/gemini.js buildPrompt). This module shows what a
 * deterministic post-generation check against the SAME allowlist would catch,
 * and the eval measures it. The allowlist is copied from the app's prompt; it
 * has NOT been verified against the statutes themselves.
 */
export const ALLOWED = {
  KMC: new Set(['308', '321', '321A', '322']), // Karnataka Municipal Corporations Act, 1976
  BYELAW: new Set(['2.2', '2.5', '3.0', '4.6']), // BBMP Building Bye-laws, 2003
  KTCP: new Set(['14', '15', '76-FF']), // Karnataka Town and Country Planning Act, 1961
};

const FOREIGN = /\b(IPC|Indian Penal Code|Penal Code|Constitution|Supreme Court|High Court|AIR\s?\d|SCC|Companies Act|Consumer Protection|Environment Protection)\b|\bv\.\s/i;
const FALLBACK = /Refer to applicable BBMP Building Bye-?laws,? 2003/i;

function actOf(clause) {
  if (/Municipal Corporations? Act|\bKMC\b|BBMP Act/i.test(clause)) return 'KMC';
  if (/Bye-?laws?/i.test(clause)) return 'BYELAW';
  if (/Town and Country Planning|\bKTCP\b|\bTCP Act\b/i.test(clause)) return 'KTCP';
  return null;
}

/** Returns { ok, violations: [...], citations: n } for a notice text (or array of cite strings). */
export function validateCitations(input) {
  const text = Array.isArray(input) ? input.join('\n') : String(input);
  // Split into clauses; also split after "prosecution under"/"; also" style joins by sentence-ish breaks.
  const clauses = text.split(/[\n;]+|,\s*(?=prosecution|also|and)/i);
  const violations = [];
  let citations = 0;
  for (const clause of clauses) {
    const refs = [...clause.matchAll(/(?:Section|Sec\.?|§|Bye-?law|Article)\s*(\d+(?:\.\d+)?(?:-[A-Z]{1,2}|[A-Z])?)/gi)];
    if (refs.length === 0 && !FOREIGN.test(clause)) continue;
    if (FOREIGN.test(clause)) {
      citations++;
      violations.push({ clause: clause.trim(), reason: 'authority outside allowlist' });
      continue;
    }
    const act = actOf(clause);
    for (const m of refs) {
      citations++;
      const id = m[1].toUpperCase();
      const key = /Bye-?law/i.test(m[0]) ? 'BYELAW' : act;
      if (!key) {
        violations.push({ clause: clause.trim(), reason: `section ${id} with no identifiable Act` });
        continue;
      }
      if (!ALLOWED[key].has(id)) violations.push({ clause: clause.trim(), reason: `${key} ${id} not in allowlist` });
    }
  }
  return { ok: violations.length === 0, violations, citations, usedFallbackPhrase: FALLBACK.test(text) };
}
