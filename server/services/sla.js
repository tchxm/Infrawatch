/**
 * SLA tier + status helpers (extracted verbatim from routes/violations.js so
 * the logic can be unit-tested; behaviour is unchanged).
 * Confidence is on a 0-100 scale.
 */
export function getSlaHours(confidence) {
  return confidence >= 90 ? 4 : confidence >= 80 ? 12 : 24;
}

export function getSlaStatus(ageHours, slaHours) {
  return ageHours > slaHours ? 'BREACHED'
       : ageHours > slaHours * 0.8 ? 'AT_RISK'
       : 'ON_TIME';
}
