import * as fs from 'node:fs';
import * as path from 'node:path';
import { debug } from './debug.js';

const REQUIRED_ENTRIES = ['.agent-runs/'];

export function ensureGitignoreEntries(
  targetDir: string,
  opts: { dryRun?: boolean } = {},
): { action: 'created' | 'updated' | 'unchanged' } {
  const dryRun = opts.dryRun ?? false;
  const gitignorePath = path.join(targetDir, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    if (!dryRun) {
      fs.writeFileSync(gitignorePath, REQUIRED_ENTRIES.join('\n') + '\n', 'utf-8');
    }
    debug('created .gitignore with kb entries');
    return { action: 'created' };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  const lines = existing.split(/\r?\n/);
  const missing = REQUIRED_ENTRIES.filter(entry => !lines.includes(entry));

  if (missing.length === 0) {
    debug('.gitignore already contains all kb entries');
    return { action: 'unchanged' };
  }

  if (!dryRun) {
    const suffix = existing.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, suffix + missing.join('\n') + '\n', 'utf-8');
  }
  debug(`appended to .gitignore: ${missing.join(', ')}`);
  return { action: 'updated' };
}
