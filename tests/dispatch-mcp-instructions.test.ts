import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  INSTRUCTIONS,
  REFERENCE,
  REFERENCE_URI,
  createServer,
} from '../packages/dispatch-mcp/src/create-server.js';
import { V2_REFUSAL_CODES } from '@kb/dispatch-core';

const repoRoot = path.resolve(__dirname, '..');
const orchestratorPath = path.join(repoRoot, 'contract/roles/orchestrator.md');

// The MCP client delivers only the first 2,048 characters of the server instructions.
const DELIVERED_CHARS = 2048;
const HEAD_LAST_SENTENCE =
  'Return to the operator only for: the completion report, a chain past two fix-ups, a merge conflict, a refusal or run outcome that needs operator action, a dead credential, or a new design decision.';

const MOVED_HEADINGS = [
  '## Tools',
  '## Dispatch modes',
  '## Refusal codes',
  '## Parallel work',
  '## Available models',
  '## Credentials',
  '## Orchestration recipe',
];

describe('kb-dispatch MCP instructions', () => {
  // Why: an orchestrator that never receives the loop sends fix-up after fix-up and asks the operator to approve each.
  it('delivers the complete orchestration loop inside the first 2,048 characters', () => {
    const delivered = INSTRUCTIONS.slice(0, DELIVERED_CHARS);
    for (const phrase of [
      'derive-review',
      'merge-delivery',
      '`fix`',
      '`dismiss`',
      '`defer`',
      'Do not ask the operator to approve a fix-up',
      'Never run tests yourself',
      'Each fix adds a test that fails before the fix and passes after it.',
      '`derive-review` on the fix-up HO then reviews only the fix-up',
      'with your `judgments` for every finding of every review on the chain',
      'Return to the operator only for',
      HEAD_LAST_SENTENCE,
    ]) {
      expect(delivered, phrase).toContain(phrase);
    }
  });

  // Why: the loop is all an orchestrator receives, so it must carry the fix-up budget, the conflict exit and the judgment entry shape itself.
  it('states the fix-up budget, the merge-conflict exit and the judgment entry shape inside the first 2,048 characters', () => {
    const delivered = INSTRUCTIONS.slice(0, DELIVERED_CHARS);
    for (const phrase of [
      'At most two fix-ups on one chain; past that, stop and report to the operator: the slice or the spec is wrong.',
      'a merge conflict',
      'Finding ids come from the review response; each entry is `{finding, judgment, reason}` (plus `review` with several reviews)',
      'while the chain has no finished review',
    ]) {
      expect(delivered, phrase).toContain(phrase);
    }
  });

  // Why: the later recipe must agree with the loop on the budget and on what a slice-generated fix-up carries.
  it('keeps one fix-up budget for the chain and tells how a slice fix-up gets its write scope', () => {
    for (const text of [INSTRUCTIONS, REFERENCE]) {
      expect(text).not.toContain('≤2 fix-up dispatches per implement');
    }
    expect(REFERENCE).toContain('at most two fix-ups on one chain, review-driven or not');
    expect(REFERENCE).toContain("carries the slice row's write scope");
  });

  // Why: the whole instruction string must fit the smallest client cap, and the pointer to the rest must survive it.
  it('fits the whole instruction string in the 2,048-character client cap and names the reference resource', () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(DELIVERED_CHARS);
    expect(INSTRUCTIONS.startsWith('## kb-dispatch: the loop')).toBe(true);
    expect(INSTRUCTIONS).toContain('kb-dispatch');
    expect(INSTRUCTIONS).toContain(REFERENCE_URI);
    expect(INSTRUCTIONS).toContain('as close to mechanical as possible');
  });

  // Why: the full instructions must stay small enough to read; the later recipe must agree with the loop.
  it('no longer says a fix-up needs no review', () => {
    for (const text of [INSTRUCTIONS, REFERENCE]) {
      expect(text).not.toContain('unless you judge the change large enough');
    }
    expect(REFERENCE).toContain('`derive-review` covers only the commits it did not see');
  });

  // Why: the review advises; the merge gate is test evidence plus judgments, never the review outcome.
  it('never claims a review outcome blocks the merge', () => {
    for (const text of [INSTRUCTIONS, REFERENCE]) {
      expect(text).not.toContain('On review pass');
      expect(text).not.toContain('passed_no_blocking_or_medium_findings');
      expect(text).not.toContain('gates on review evidence');
    }
  });

  // Why: three sessions added a redteam of built code to a build chain because the shipped text said a redteam
  // breaks "the implementation"; the rule must ship in both the server instructions and the orchestrator role.
  it("says a redteam is for a plan or spec before the build, or the operator's order, and not a build-chain step", () => {
    const newRedteamRow =
      "| redteam | A plan or spec before the build, or on the operator's order | Adversarial findings against the named target; writes no code |";
    const buildChainSentence =
      "A work item's build chain is implement, code_review, merge; a redteam runs on a plan or spec before the build, or on the operator's order, never as a step you add to a build chain.";

    expect(REFERENCE).toContain(newRedteamRow);
    for (const text of [INSTRUCTIONS, REFERENCE]) {
      expect(text).not.toContain('Actively tries to break the implementation');
    }

    const orchestratorText = fs.readFileSync(orchestratorPath, 'utf-8');
    expect(orchestratorText).toContain(buildChainSentence);
  });

  // Why: the client cap hides everything past 2,048 characters, so every moved fact must be reachable
  // through a real client reading the resource the delivered instructions name.
  it('serves the instructions and the full reference to a connected MCP client', async () => {
    const server = createServer();
    const client = new Client({ name: 'kb-dispatch-instructions-test', version: '0.0.1' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS);

      const resources = await client.listResources();
      const listed = (resources.resources ?? []).find((resource) => resource.uri === REFERENCE_URI);
      expect(listed).toBeTruthy();
      expect(listed?.mimeType).toBe('text/markdown');

      const read = await client.readResource({ uri: REFERENCE_URI });
      expect(read.contents).toHaveLength(1);
      const content = read.contents[0]!;
      expect(content.mimeType).toBe('text/markdown');
      const text = 'text' in content ? content.text : '';
      expect(text).toBe(REFERENCE);

      for (const heading of MOVED_HEADINGS) {
        expect(text, heading).toContain(heading);
      }
      for (const code of V2_REFUSAL_CODES) {
        expect(text, code).toContain(code);
      }
      for (const paragraph of [
        '**`BASE_DRIFT` refusal:**',
        '**`REVIEWED_SHA_MISMATCH` refusal:**',
        '**Session hygiene:**',
        '**SaaS backends (codex/claude):**',
      ]) {
        expect(text, paragraph).toContain(paragraph);
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
