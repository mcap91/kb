import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DashboardData } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'template', 'index.html');

export function emit(repoRoot: string, id: string, data: DashboardData): string {
  const outDir = join(repoRoot, 'wiki', 'dashboard');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const json = JSON.stringify(data, null, 2);
  const html = template.replace('__DASHBOARD_DATA__', () => json);

  const outPath = join(outDir, `${id}.html`);
  writeFileSync(outPath, html, 'utf-8');
  return outPath;
}
