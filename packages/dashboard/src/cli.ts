import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTracker } from './parse-tracker.js';
import { parseInitiative } from './parse-initiative.js';
import { parseWkSet, expandRange } from './parse-wk-set.js';
import { emit } from './emit.js';
import { parseFrontmatter } from './util.js';

const repoRoot = process.cwd();
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: npm run dashboard -- <ID> [<ID>...]');
  console.error('  PLN-0004          Plan with tracker');
  console.error('  IN-0004           Initiative with linked WKs');
  console.error('  WK-0070..WK-0075  Work item range');
  console.error('  WK-0070 WK-0072   Work item list');
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
    const data = parseTracker(
      readFileSync(trackerPath, 'utf-8'),
      { id, title: fm['title'] || id, status: fm['status'] || 'unknown' },
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
    const label = ids.length === 1 ? ids[0] : `${ids[0]}--${ids[ids.length - 1]}`;
    const data = parseWkSet(repoRoot, ids);
    console.log(emit(repoRoot, label, data));
    break;
  }
  default:
    console.error(`Unknown record prefix: ${prefix}`);
    process.exit(1);
}
