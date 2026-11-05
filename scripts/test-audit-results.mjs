import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuditResult } from './audit-results.mjs';

test('success with no skips has no reported coverage gaps', () => {
  assert.deepEqual(classifyAuditResult({ status: 0, stdout: 'ℹ skipped 0\n' }), { state: 'passed', gaps: [] });
});

test('native spec reporter preserves the skipped name and reason', () => {
  const notice = '﹣ preset tools (1ms) # missing DSH';
  assert.deepEqual(classifyAuditResult({ status: 0, stdout: `${notice}\nℹ skipped 1` }),
    { state: 'partial', gaps: [notice] });
});

test('legacy coverage notices and native skips remain visible and deduplicated', () => {
  const result = classifyAuditResult({ status: 0,
    stdout: '\x1b[33m⏭ 跳过：voice-tool\x1b[0m\n⏭ 跳过：voice-tool\nok 2 - tools # SKIP missing DSH\n' });
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.gaps, ['⏭ 跳过：voice-tool', 'ok 2 - tools # SKIP missing DSH']);
});

test('summary-only skips are coverage gaps for spec and TAP reporters', () => {
  for (const stdout of ['ℹ skipped 2', '# skipped 1', 'ℹ todo 1']) {
    assert.equal(classifyAuditResult({ status: 0, stdout }).state, 'partial');
  }
});

test('failure, signal termination and timeout take precedence over skips', () => {
  for (const result of [{ status: 1 }, { status: null }, { status: 0, error: new Error('timeout') }]) {
    assert.equal(classifyAuditResult({ ...result, stderr: '⏭ 跳过：tools' }).state, 'failed');
  }
});
