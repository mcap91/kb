/**
 * WK-0268/HO-0209 — buildClaudeSettingsJson's Edit allow-list must be
 * absolute (`//<clonePath>/...`), same as its Read rule, so a worker's Bash
 * `cd` cannot move it out from under a relative pattern. Pure/synchronous,
 * no bwrap required. No personal/absolute paths in fixtures (WK-0043 rule)
 * — clonePath below is synthetic.
 */
import { describe, expect, it } from 'vitest';

import { buildClaudeSettingsJson } from '../packages/dispatch-core/src/pipeline.js';

const clonePath = '/home/user/.kb-dispatch/clones/RUN-CLAUDE-SETTINGS';

describe('buildClaudeSettingsJson — absolute Edit rules (WK-0268)', () => {
  it('mixed write_scope (dir entry with a trailing slash, file entry) and a clone path with its leading slash stripped yields absolute Read/Edit rules only', () => {
    const writeScope = ['skills/ntfy-bridge/', 'docs/notes.md'];
    const json = buildClaudeSettingsJson(writeScope, clonePath, 'implement');
    const settings = JSON.parse(json);

    expect(settings.permissions.allow).toEqual([
      `Read(//${clonePath.slice(1)}/**)`,
      'Bash',
      `Edit(//${clonePath.slice(1)}/skills/ntfy-bridge/**)`,
      `Edit(//${clonePath.slice(1)}/docs/notes.md)`,
    ]);

    for (const entry of settings.permissions.allow) {
      if (entry.startsWith('Edit(') || entry.startsWith('Read(')) {
        expect(entry).toMatch(/^(Edit|Read)\(\/\//);
      }
    }
  });

  it('non-implement modes still deny Edit, Write, NotebookEdit', () => {
    const json = buildClaudeSettingsJson([], clonePath, 'review');
    const settings = JSON.parse(json);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'NotebookEdit']),
    );
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
