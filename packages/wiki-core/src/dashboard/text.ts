import * as path from 'node:path';
import { TERMINAL_PREDECESSOR_STATUSES } from '../deps.js';

export type StatusColor = 'blue' | 'green' | 'grey' | 'red';

export const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  review: 1,
  blocked: 2,
  todo: 3,
  inbox: 4,
  parked: 5,
  done: 6,
};

export const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isClosedStatus(status: string | undefined): boolean {
  return typeof status === 'string' && TERMINAL_PREDECESSOR_STATUSES.has(status);
}

/** An open work item is not `done` and not closed; `parked` is open. */
export function isOpenWorkItem(status: string | undefined): boolean {
  if (!status) return false;
  return status !== 'done' && !isClosedStatus(status);
}

export function statusRank(status: string | undefined): number {
  if (!status) return 9;
  return STATUS_ORDER[status] ?? 8;
}

export function priorityRank(priority: string | undefined): number {
  if (!priority) return 4;
  return PRIORITY_ORDER[priority] ?? 4;
}

export function statusColor(status: string | undefined): StatusColor {
  if (status === 'done') return 'green';
  if (status === 'in_progress' || status === 'review') return 'blue';
  if (status === 'blocked') return 'red';
  return 'grey';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe to embed in a script element (a record cannot close the element). */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Cut a title to `max` characters; a longer title ends in an ellipsis. */
export function cutTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  return title.slice(0, Math.max(0, max - 1)) + '…';
}

export function isValidDate(value: string | undefined): value is string {
  return typeof value === 'string' && DATE_RE.test(value);
}

export function maxDate(dates: Array<string | undefined>): string | undefined {
  let max: string | undefined;
  for (const date of dates) {
    if (!isValidDate(date)) continue;
    if (max === undefined || date > max) max = date;
  }
  return max;
}

/** A relative href from a page directory to a record file. */
export function relativeHref(fromDir: string, toPath: string): string {
  return path.relative(fromDir, toPath).replace(/\\/g, '/');
}

const THEME_HEAD = `<script>
(function(){var t=null;try{t=localStorage.getItem('kb-dash-theme')}catch(_){}
if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}
document.documentElement.setAttribute('data-theme',t)})();
</script>`;

const THEME_FOOT = `<script>
document.getElementById('theme').addEventListener('click',function(){var r=document.documentElement;
var t=r.getAttribute('data-theme')==='dark'?'light':'dark';r.setAttribute('data-theme',t);
try{localStorage.setItem('kb-dash-theme',t)}catch(_){}});
</script>`;

const CSS = `:root{--bg:#0f1115;--surface:#171a21;--surface-2:#1d212a;--ink:#e6e8ee;--ink-2:#a8adba;--ink-3:#6d7382;--border:#2a2f3a;--border-strong:#3a4150;--accent:#6ea8fe;--prog:#6ea8fe;--done:#59c98a;--blocked:#e06c75;--r:8px}
html[data-theme=light]{--bg:#f4f5f8;--surface:#fff;--surface-2:#eef0f4;--ink:#1a1d24;--ink-2:#4a5060;--ink-3:#7b8194;--border:#dfe2e9;--border-strong:#c4c9d4;--accent:#2f6fdb;--prog:#2f6fdb;--done:#1f9d57;--blocked:#c0392b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--accent)}
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 22px;border-bottom:1px solid var(--border);background:var(--surface)}
.head h1{margin:0;font-size:17px}
.stamp{color:var(--ink-3);font-size:12px;margin:6px 0 0}
.subtitle{color:var(--ink-2);margin:4px 0 0}
#theme{background:var(--surface-2);color:var(--ink);border:1px solid var(--border-strong);border-radius:6px;padding:5px 10px;font:inherit;cursor:pointer}
main{padding:22px;max-width:1180px;margin:0 auto}
.section{margin:0 0 22px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r)}
.section-title{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin:0 0 10px}
.in-row,.path-row,.next-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)}
.in-row:last-child,.path-row:last-child,.next-row:last-child{border-bottom:none}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--border-strong)}
.dot[data-color=blue]{background:var(--prog)}.dot[data-color=green]{background:var(--done)}
.dot[data-color=red]{background:var(--blocked)}.dot[data-color=grey]{background:var(--border-strong)}
.card{display:block;padding:12px 14px;margin:8px 0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);text-decoration:none;color:var(--ink)}
.card[data-blocked]{border-color:var(--blocked)}
.band{padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);margin:12px 0}
.band-title{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px}
.strip a{color:var(--ink-2);text-decoration:none;margin-right:10px}
.legend{color:var(--ink-3);font-size:12px}
.gate{margin:6px 0;padding:8px 10px;border-left:3px solid var(--accent);background:var(--surface);color:var(--ink-2);white-space:pre-wrap}
.next{margin:10px 0;padding:10px 12px;border:1px solid var(--accent);border-radius:var(--r);background:var(--surface-2)}
.next-title{font-weight:700;margin-bottom:6px}
.next-label{color:var(--ink-3);font-size:12px;margin-top:6px}
.stale{color:var(--blocked);font-size:12px;margin-top:6px}
.chip{display:inline-block;font-size:11px;border:1px solid var(--border-strong);border-radius:10px;padding:1px 8px;color:var(--ink-2);margin-left:6px}
.after{color:var(--blocked);font-size:12px}
.meta{color:var(--ink-3);font-size:12px}
.empty{color:var(--ink-3)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
#jump{background:var(--surface);color:var(--ink);border:1px solid var(--border-strong);border-radius:6px;padding:6px 10px;font:inherit;width:180px}`;

export interface PageShellInput {
  title: string;
  headHtml: string;
  bodyHtml: string;
}

/** The HTML shell every generated page shares. */
export function pageShell(input: PageShellInput): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
${THEME_HEAD}
<style>${CSS}</style>
</head>
<body>
<header class="head"><div>${input.headHtml}</div><button id="theme" type="button">light / dark</button></header>
<main>
${input.bodyHtml}
</main>
${THEME_FOOT}
</body>
</html>
`;
}
