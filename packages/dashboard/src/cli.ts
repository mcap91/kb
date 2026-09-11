import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTracker } from './parse-tracker.js';
import { parseInitiative } from './parse-initiative.js';
import { parseWkSet, expandRange } from './parse-wk-set.js';
import { emit } from './emit.js';
import { parseFrontmatter } from './util.js';

const rawArgs = process.argv.slice(2);
let repoRoot = process.cwd();
let listMode = false;
const args: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--dir' && i + 1 < rawArgs.length) {
    repoRoot = resolve(rawArgs[++i]);
  } else if (rawArgs[i] === '--list') {
    listMode = true;
  } else {
    args.push(rawArgs[i]);
  }
}

if (listMode) {
  const dashDir = join(repoRoot, 'wiki', 'dashboard');
  if (existsSync(dashDir)) {
    const paths = readdirSync(dashDir)
      .filter(f => f.endsWith('.html'))
      .sort()
      .map(f => join(dashDir, f));
    for (const p of paths) console.log(p);
  }
  process.exit(0);
}

if (args.length === 0) {
  console.error('Usage: npm run dashboard -- <ID> [--dir <path>] [<ID>...]');
  console.error('  PLN-0004                    Plan with tracker');
  console.error('  IN-0004                     Initiative with linked WKs');
  console.error('  WK-0070..WK-0075            Work item range');
  console.error('  WK-0070 WK-0072             Work item list');
  console.error('  --dir /path/to/repo         Repo root (default: cwd)');
  console.error('  --list                      List existing wiki/dashboard/*.html paths and exit');
  process.exit(1);
}

const prefix = args[0].split('-')[0];

switch (prefix) {
  case 'PLN': {
    const id = args[0];
    const planPath = join(repoRoot, 'wiki', 'plans', `${id}.md`);
    const trackerPath = join(repoRoot, 'wiki', 'plans', id, 'execution', 'tracker.md');

    if (!existsSync(planPath)) { console.error(`Not found: ${planPath}`); process.exit(1); }
    if (!existsSync(trackerPath)) { console.error(`Not found: ${trackerPath}`); process.exit(1); }

    const fm = parseFrontmatter(readFileSync(planPath, 'utf-8'));
    // Cross-dashboard back-link (WK-0084): only meaningful if the PLN declares its parent
    // IN and that IN's dashboard has actually been generated -- the template has no
    // filesystem access, so both facts must be resolved here at generation time.
    const parentInitiative = fm['initiative'] || undefined;
    const parentDashboardExists = parentInitiative
      ? existsSync(join(repoRoot, 'wiki', 'dashboard', `${parentInitiative}.html`))
      : undefined;
    const data = parseTracker(
      readFileSync(trackerPath, 'utf-8'),
      { id, title: fm['title'] || id, status: fm['status'] || 'unknown', parentInitiative, parentDashboardExists },
    );
    console.log(emit(repoRoot, id, data));
    break;
  }
  case 'IN': {
    const id = args[0];
    const data = parseInitiative(repoRoot, id);
    console.log(emit(repoRoot, id, data));
    break;
  }
  case 'WK': {
    const ids = args.flatMap(a => a.includes('..') ? expandRange(a, repoRoot) : [a]);
    if (ids.length === 0) { console.error('No matching WK records found'); process.exit(1); }
    const label = ids.length === 1 ? ids[0] : `from-${ids[0]}`;
    const data = parseWkSet(repoRoot, ids);
    console.log(emit(repoRoot, label, data));
    break;
  }
  default:
    console.error(`Unknown record prefix: ${prefix}`);
    process.exit(1);
}
