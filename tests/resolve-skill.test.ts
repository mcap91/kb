/**
 * Pins WK-0240 stage 1: the /resolve skill ships model-invocable, with a
 * pre-escalation opening, the T2 fix (operator-only check before search),
 * and a template pointer; and planner.md's one /resolve sentence.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const skillPath = path.join(repoRoot, 'contract/skills/resolve/SKILL.md');
const skillDir = path.join(repoRoot, 'contract/skills');
const plannerPath = path.join(repoRoot, 'contract/roles/planner.md');

const skillText = fs.readFileSync(skillPath, 'utf-8');
const plannerText = fs.readFileSync(plannerPath, 'utf-8');

const ledgerCodePattern = /\b(RD|F|DEC|WK|SRC)-?\d+\b/;

describe('contract/skills/resolve/SKILL.md', () => {
  it('exists, declares name: resolve, and carries no disable-model-invocation flag (WK-0240 ruling 4 reversed: model-invocable)', () => {
    expect(fs.existsSync(skillPath)).toBe(true);
    const frontmatterMatch = skillText.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    expect(frontmatterMatch![1]).toMatch(/^name:\s*resolve\s*$/m);
    expect(skillText).not.toContain('disable-model-invocation');
  });

  it('contract/skills/ contains exactly one entry, resolve/, with exactly one file, SKILL.md (no agents/openai.yaml: shape unverified)', () => {
    const skillsEntries = fs.readdirSync(skillDir);
    expect(skillsEntries).toEqual(['resolve']);

    const resolveEntries = fs.readdirSync(path.join(skillDir, 'resolve'));
    expect(resolveEntries).toEqual(['SKILL.md']);
  });

  it('opens as a pre-escalation gate, not a correction of the operator', () => {
    // First non-heading paragraph is the line right after the "# Resolve" heading.
    const bodyAfterHeading = skillText.split(/^# Resolve$/m)[1] ?? '';
    const firstParagraph = bodyAfterHeading.trimStart().split(/\n\n/)[0];
    expect(firstParagraph.replace(/\s+/g, ' ')).toMatch(
      /^Before you escalate a question to the operator, resolve it from evidence\./,
    );
  });

  it('points to wiki/templates/escalation.md and carries no inline five-line operator statement (single-copy pointer, not a duplicate)', () => {
    expect(skillText).toContain('wiki/templates/escalation.md');
    expect(skillText).not.toContain('Operator action needed: yes — <why');
  });

  it('puts the operator-only check (step 2) before the search (step 3) — the T2 fix', () => {
    const step2Idx = skillText.indexOf('### 2. Check the operator-only cases first');
    const step3Idx = skillText.indexOf('### 3. Search');
    expect(step2Idx).toBeGreaterThan(-1);
    expect(step3Idx).toBeGreaterThan(-1);
    expect(step2Idx).toBeLessThan(step3Idx);
  });

  it('contains no ledger codes (RD/F/DEC/WK/SRC)', () => {
    expect(skillText).not.toMatch(ledgerCodePattern);
  });

  it('seat bullet needs no Bash call: no CLAUDE_CODE_SESSION_ID, echo $, or printenv (WK-0240 ruling 2026-11-02: a headless seat denies that call)', () => {
    // a headless -p seat denies a Bash call that reads this env var for the session id
    expect(skillText).not.toContain('CLAUDE_CODE_SESSION_ID');
    // a headless -p seat denies a Bash call that echoes an env var to find the session id
    expect(skillText).not.toContain('echo $');
    // a headless -p seat denies a Bash call that uses printenv to find the session id
    expect(skillText).not.toContain('printenv');
  });

  it('seat bullet tells the agent not to run a command to find its session id (WK-0240 ruling 2026-11-02, option (a))', () => {
    // WK-0240 operator ruling 2026-11-02, option (a): the skill must tell the agent not to run a command to find its session id
    expect(skillText).toContain('Do not run a command to find it');
  });
});

describe('contract/roles/planner.md', () => {
  it('directs a stuck planner to run /resolve before escalating, and no longer says it cannot call it itself', () => {
    expect(plannerText).toContain(
      'When you are stuck on a question, run `/resolve` before you escalate it.',
    );
    expect(plannerText).not.toContain('cannot call it yourself');
  });

  it('contains no ledger codes (RD/F/DEC/WK/SRC)', () => {
    expect(plannerText).not.toMatch(ledgerCodePattern);
  });
});
