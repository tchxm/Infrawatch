/** Binary detection metrics. rows: [{ truth: boolean, pred: boolean }] */
export function confusion(rows) {
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const { truth, pred } of rows) {
    if (truth && pred) c.tp++;
    else if (!truth && pred) c.fp++;
    else if (!truth && !pred) c.tn++;
    else c.fn++;
  }
  return c;
}

const div = (a, b) => (b === 0 ? null : a / b);

export function summarize(rows) {
  const c = confusion(rows);
  const precision = div(c.tp, c.tp + c.fp);
  const recall = div(c.tp, c.tp + c.fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { n: rows.length, ...c, precision, recall, f1, false_positive_rate: div(c.fp, c.fp + c.tn), accuracy: div(c.tp + c.tn, rows.length) };
}
