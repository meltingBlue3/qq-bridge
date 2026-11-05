// Accept native node:test skips and the older scripts' explicit coverage notices.
export function classifyAuditResult({ status, error, stdout = '', stderr = '' }) {
  const output = `${stdout}\n${stderr}`;
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const gaps = [...new Set(lines.map((line) => line.trim()).filter((line) =>
    line.includes('⏭') || /^﹣\s/.test(line) || /# (?:SKIP|TODO)\b/i.test(line)
  ))];
  if (!gaps.length) {
    const skipped = lines.find((line) => /^(?:ℹ|#)\s+(?:skipped|todo)\s+[1-9]\d*\b/.test(line.trim()));
    if (skipped) gaps.push(skipped.trim());
  }
  return {
    state: error || status !== 0 ? 'failed' : gaps.length ? 'partial' : 'passed',
    gaps,
  };
}
