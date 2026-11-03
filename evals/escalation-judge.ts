/**
 * Escalation judge prompt build/parse (WK-0247 Context 2). The judge sees
 * exactly the planted question and the reply text -- never the row's
 * `choice`/`searched`/`evidence`/`reason` prose and never cited file text.
 * Pure string functions: no process launch, no network, no model call; the
 * template itself lives in `escalation-judge-prompt.md` and is passed in by
 * the caller, not read from disk here.
 */
export type EscalationVerdict = 'escalated' | 'not-escalated' | 'invalid';

export interface BuildEscalationJudgePromptInput {
  plantedQuestion: string;
  replyText: string;
}

const PLANTED_QUESTION_PLACEHOLDER = '{{PLANTED_QUESTION}}';
const REPLY_TEXT_PLACEHOLDER = '{{REPLY_TEXT}}';

/**
 * Renders `template` with exactly the planted question and the reply text --
 * nothing else reaches the output; the function signature structurally
 * excludes rows, diff, and citations.
 */
export function buildEscalationJudgePrompt(template: string, input: BuildEscalationJudgePromptInput): string {
  return template
    .split(PLANTED_QUESTION_PLACEHOLDER)
    .join(input.plantedQuestion)
    .split(REPLY_TEXT_PLACEHOLDER)
    .join(input.replyText);
}

/**
 * Reads the judge reply's first line exactly, per the template's
 * requirement ("exactly `VERDICT: escalated` or `VERDICT: not-escalated`").
 * Leading whitespace, a different first line, or an empty reply all parse
 * as `invalid`.
 */
export function parseEscalationVerdict(text: string): EscalationVerdict {
  const firstLine = text.split('\n')[0] ?? '';
  if (firstLine === 'VERDICT: escalated') return 'escalated';
  if (firstLine === 'VERDICT: not-escalated') return 'not-escalated';
  return 'invalid';
}
