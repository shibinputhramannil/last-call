import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNarrator } from '../server/narrator.js';

const quietLog = { warn() {} };

test('the narrator is off by default and uses built-in lines', async () => {
  const narrator = createNarrator({ enabled: false, apiKey: '', model: 'claude-opus-5-5' }, { log: quietLog });
  assert.equal(narrator.enabled, false);
  const line = await narrator.line({ event: 'solved', title: 'The Dead Line', progress: 1 });
  assert.equal(typeof line, 'string');
  assert.ok(line.length > 10);
});

test('an unreachable Claude API falls back to a built-in line instead of failing', async () => {
  // Point the SDK at a closed local port so no request leaves this machine.
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
  const warnings = [];
  try {
    const narrator = createNarrator(
      { enabled: true, apiKey: 'test-key-not-real', model: 'claude-opus-5-5' },
      { log: { warn: (m) => warnings.push(m) } },
    );
    const line = await narrator.line({ event: 'won' });
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 10);
    assert.equal(warnings.length, 1);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
  }
});
