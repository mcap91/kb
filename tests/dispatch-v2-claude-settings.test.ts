/**
 * WK-0268/HO-0209 (absolute Read rule) + managed Claude editing: Edit/Write/
 * NotebookEdit are denied in every mode, so Bash is Claude's only write
 * path; no more per-write_scope `Edit(...)` allow entries — a bare-name deny
 * wins over them, so they would be dead grants. Pure/synchronous, no bwrap
 * required. No personal/absolute paths in fixtures (WK-0043 rule) —
 * clonePath below is synthetic.
 */
import { describe, expect, it } from 'vitest';

import { buildClaudeSettingsJson } from '../packages/dispatch-core/src/pipeline.js';

const clonePath = '/home/user/.kb-dispatch/clones/RUN-CLAUDE-SETTINGS';

describe('buildClaudeSettingsJson — exact-file binds, no Edit allow entries', () => {
  it('mode=implement with a mixed write_scope (dir entry with a trailing slash, file entry): allow is Read + Bash only (named behavior change — no Edit(...) entries), Read is absolute', () => {
    const writeScope = ['skills/ntfy-bridge/', 'docs/notes.md'];
    const json = buildClaudeSettingsJson(writeScope, clonePath, 'implement');
    const settings = JSON.parse(json);

    expect(settings.permissions.allow).toEqual([`Read(//${clonePath.slice(1)}/**)`, 'Bash']);
    expect(settings.permissions.allow.some((entry: string) => entry.startsWith('Edit('))).toBe(false);
  });

  it('every mode denies Edit, Write, NotebookEdit (named behavior change — previously implement-only allowed Edit)', () => {
    for (const mode of ['implement', 'review', 'code_review', 'redteam']) {
      const writeScope = mode === 'implement' ? ['docs/notes.md'] : [];
      const json = buildClaudeSettingsJson(writeScope, clonePath, mode);
      const settings = JSON.parse(json);
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']),
      );
    }
  });

  it('non-implement modes: allow is Read + Bash only', () => {
    const json = buildClaudeSettingsJson([], clonePath, 'review');
    const settings = JSON.parse(json);
    expect(settings.permissions.allow).toEqual([`Read(//${clonePath.slice(1)}/**)`, 'Bash']);
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
  });

  it('still throws for mode=implement with an empty write_scope', () => {
    expect(() => buildClaudeSettingsJson([], clonePath, 'implement')).toThrow(
      /write_scope must not be empty/,
    );
  });

  it('still throws for an absolute write_scope entry', () => {
    expect(() => buildClaudeSettingsJson(['/abs/path'], clonePath, 'implement')).toThrow(
      /must be relative/,
    );
  });

  it('still throws for a write_scope entry containing ".."', () => {
    expect(() => buildClaudeSettingsJson(['../escape'], clonePath, 'implement')).toThrow(
      /must not contain "\.\."/,
    );
  });
});
