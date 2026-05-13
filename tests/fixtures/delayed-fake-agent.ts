import { existsSync, writeFileSync } from 'node:fs';

const delayMs = Number(process.env['FAKE_AGENT_DELAY_MS'] ?? '3000');
const responsePath = process.env['AGENT_BLACKBOARD_RESPONSE_PATH'];
const reviewId = process.env['AGENT_BLACKBOARD_REVIEW_ID'];
const runId = process.env['AGENT_BLACKBOARD_RUN_ID'];
const handoffPath = process.env['AGENT_BLACKBOARD_HANDOFF_PATH'];

if (!responsePath) {
  console.error('AGENT_BLACKBOARD_RESPONSE_PATH is not set');
  process.exit(1);
}

setTimeout(() => {
  const response = [
    '# Delayed Fake Agent Response',
    '',
    `review_id: ${reviewId ?? 'unknown'}`,
    `run_id: ${runId ?? 'unknown'}`,
    `handoff_exists: ${handoffPath ? String(existsSync(handoffPath)) : 'false'}`,
    `delay_ms: ${delayMs}`,
    '',
    'Status: completed',
  ].join('\n');

  writeFileSync(responsePath, response, 'utf-8');
  process.exit(0);
}, delayMs);
