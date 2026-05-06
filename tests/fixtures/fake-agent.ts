/**
 * Fake agent for deterministic testing of the dispatch protocol.
 *
 * Reads the expected environment variables and writes a predictable
 * response to AGENT_BLACKBOARD_RESPONSE_PATH.
 *
 * Usage: tsx tests/fixtures/fake-agent.ts
 */

import { existsSync, writeFileSync } from 'node:fs';

const repoRoot = process.env['AGENT_BLACKBOARD_REPO_ROOT'];
const runDir = process.env['AGENT_BLACKBOARD_RUN_DIR'];
const responsePath = process.env['AGENT_BLACKBOARD_RESPONSE_PATH'];
const reviewId = process.env['AGENT_BLACKBOARD_REVIEW_ID'];
const runId = process.env['AGENT_BLACKBOARD_RUN_ID'];
const agentVisibleDir = process.env['AGENT_BLACKBOARD_AGENT_VISIBLE_DIR'];
const contextDir = process.env['AGENT_BLACKBOARD_CONTEXT_DIR'];
const handoffPath = process.env['AGENT_BLACKBOARD_HANDOFF_PATH'];

if (!responsePath) {
  console.error('AGENT_BLACKBOARD_RESPONSE_PATH is not set');
  process.exit(1);
}

const response = [
  '# Fake Agent Response',
  '',
  `cwd: ${process.cwd()}`,
  `review_id: ${reviewId ?? 'unknown'}`,
  `run_id: ${runId ?? 'unknown'}`,
  `repo_root: ${repoRoot ?? 'unknown'}`,
  `run_dir: ${runDir ?? 'unknown'}`,
  `agent_visible_dir: ${agentVisibleDir ?? 'unknown'}`,
  `context_dir: ${contextDir ?? 'unknown'}`,
  `handoff_path: ${handoffPath ?? 'unknown'}`,
  `handoff_exists: ${handoffPath ? String(existsSync(handoffPath)) : 'false'}`,
  '',
  'Status: completed',
  'Result: deterministic test response',
].join('\n');

writeFileSync(responsePath, response, 'utf-8');
process.exit(0);
