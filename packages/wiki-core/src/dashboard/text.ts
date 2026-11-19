import * as path from 'node:path';
import { TERMINAL_PREDECESSOR_STATUSES } from '../deps.js';
import { CSS } from './style.js';

/** The status class of the house style: the card stripe, dot and chip color. */
export type StatusClass = 'done' | 'prog' | 'blocked' | 'todo';

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

export function statusClass(status: string | undefined): StatusClass {
  if (status === 'done') return 'done';
  if (status === 'in_progress' || status === 'review') return 'prog';
  if (status === 'blocked') return 'blocked';
  return 'todo';
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
<header class="head">
<div>${input.headHtml}</div>
<button id="theme" type="button">light / dark</button>
</header>
${input.bodyHtml}
${THEME_FOOT}
</body>
</html>
`;
}
