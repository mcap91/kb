import * as path from 'node:path';
import { chainIds, type Chain, type ChainDocData } from './chain-doc.js';
import type { DashboardRecord } from './types.js';
import {
  cutTitle,
  escapeHtml,
  isClosedStatus,
  isOpenWorkItem,
  isValidDate,
  jsonForScript,
  maxDate,
  pageShell,
  priorityRank,
  relativeHref,
  statusClass,
  statusRank,
} from './text.js';

export interface PageBuildInput {
  targetDir: string;
  records: DashboardRecord[];
  workItemPrefix: string;
  initiativePrefix: string;
  repoName: string;
  chain: ChainDocData;
  chainExists: boolean;
}

/** The page that shows the critical paths of `chain.md`, written only when it has one. */
export const CRITICAL_PATH_PAGE = 'critical-path.html';

/**
 * The chain page of an initiative, relative to the owned folder: one folder named
 * by the initiative prefix, so the top of the folder holds only the main pages.
 */
function chainPage(input: PageBuildInput, id: string): string {
  return `${input.initiativePrefix}/${id}.html`;
}

/** Card titles are clamped to three lines by CSS; this only bounds the page size. */
const CARD_TITLE_MAX = 180;
const ROW_TITLE_MAX = 120;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasIdShape(id: string, prefix: string): boolean {
  return new RegExp(`^${escapeRegExp(prefix)}-\\d+$`).test(id);
}

function numericPart(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function link(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/** The stamp line: newest record date, chain.md date, then the page links. */
function stampLine(
  newest: string | undefined,
  input: PageBuildInput,
  links: string[],
  lead = '',
): string {
  let text = `Records ${newest ?? 'unknown'}`;
  if (input.chainExists) text += ` · chain.md ${input.chain.updated ?? 'unknown'}`;
  text += ' · the records win if they disagree.';
  return `<p class="stamp">${lead}${escapeHtml(text)} ${links.join(' · ')}</p>`;
}

function statusLabel(status: string): string {
  return status ? status.replace(/_/g, ' ') : 'unknown';
}

function chip(status: string): string {
  const cls = status === 'parked' ? 'parked' : statusClass(status);
  return `<span class="chip ${cls}">${escapeHtml(statusLabel(status))}</span>`;
}

function dot(status: string): string {
  return `<span class="dot ${statusClass(status)}"></span>`;
}

interface BuildContext {
  generatedDir: string;
  byId: Map<string, DashboardRecord>;
  workItems: DashboardRecord[];
  initiatives: DashboardRecord[];
  recordsWhere(predicate: (record: DashboardRecord) => boolean): string[];
}

/** The link to a record's markdown file from a page directory. */
function recordHref(pageDir: string, record: DashboardRecord): string {
  return relativeHref(pageDir, record.absPath);
}

/** Open dependencies of a work item: each `depends_on` id that is not done and not closed. */
function openDependencies(ctx: BuildContext, record: DashboardRecord): string[] {
  return record.depends_on.filter(dep => {
    const depRecord = ctx.byId.get(dep);
    return depRecord === undefined || isOpenWorkItem(depRecord.status);
  });
}

/**
 * A work item card: id, title, a meta line and a status chip. A card with an
 * open dependency and a status of `todo` or `inbox` shows in the blocked color.
 */
function workCard(ctx: BuildContext, record: DashboardRecord, href: string, metaTail: string[]): string {
  const after = openDependencies(ctx, record);
  const blocked = after.length > 0 && (record.status === 'todo' || record.status === 'inbox');
  const cls = blocked ? 'blocked' : statusClass(record.status);
  const priority = record.priority ?? '';
  const meta = [`<span class="pri-${escapeHtml(priority)}">${escapeHtml(priority)}</span>`, ...metaTail];
  if (after.length > 0) meta.push(`after ${escapeHtml(after.join(', '))}`);
  return (
    `<a class="card ${cls}" data-wk="${escapeHtml(record.id)}" data-status="${escapeHtml(record.status)}"${blocked ? ' data-blocked="true"' : ''} href="${escapeHtml(href)}">` +
    `<div class="cid">${escapeHtml(record.id)}</div>` +
    `<div class="ctitle">${escapeHtml(cutTitle(record.title, CARD_TITLE_MAX))}</div>` +
    `<div class="cmeta">${meta.join(' · ')}</div>` +
    `${chip(record.status)}</a>`
  );
}

/** A card for an id that has no record: plain text, no link. */
function missingCard(id: string): string {
  return `<div class="card todo" data-wk="${escapeHtml(id)}" data-status=""><div class="cid">${escapeHtml(id)}</div><div class="cmeta">no record</div></div>`;
}

// ---------------------------------------------------------------------------
// index.html
// ---------------------------------------------------------------------------

const LEGEND =
  `<div class="subtitle legend" data-legend>` +
  `<span>${dot('in_progress')}in progress</span>` +
  `<span>${dot('done')}done</span>` +
  `<span>${dot('todo')}to do</span>` +
  `<span>${dot('blocked')}blocked</span></div>`;

function buildIndex(input: PageBuildInput, ctx: BuildContext): string {
  const newest = maxDate(input.records.map(r => r.updated));
  const active = ['in_progress', 'review', 'blocked'];
  const boxes: Array<{ key: string; label: string; records: DashboardRecord[] }> = [
    { key: 'in-progress', label: 'In progress', records: ctx.initiatives.filter(r => active.includes(r.status)) },
    {
      key: 'todo',
      label: 'To do',
      records: ctx.initiatives.filter(
        r => !active.includes(r.status) && r.status !== 'done' && !isClosedStatus(r.status),
      ),
    },
    { key: 'done', label: 'Done', records: ctx.initiatives.filter(r => r.status === 'done' || isClosedStatus(r.status)) },
  ];

  let body = '';
  for (const box of boxes) {
    const rows = [...box.records].sort((a, b) => compareIds(a.id, b.id));
    body += `<section class="section" data-box="${box.key}" data-count="${rows.length}">\n`;
    body += `<div class="section-title${box.key === 'in-progress' ? ' now' : ''}">${box.label} · ${rows.length}</div>\n`;
    if (rows.length === 0) {
      body += `<div class="toc"><span class="empty">none</span></div>\n`;
    } else {
      // Two columns, filled down the left column first so the rows read in id order.
      body += `<nav class="toc" style="grid-template-rows:repeat(${Math.ceil(rows.length / 2)},auto)">`;
      for (const record of rows) {
        body +=
          `<a class="toc-row" data-in="${escapeHtml(record.id)}" data-status="${escapeHtml(record.status)}" href="${escapeHtml(chainPage(input, record.id))}">` +
          `${dot(record.status)}<b>${escapeHtml(record.id)}</b><span>${escapeHtml(cutTitle(record.title, ROW_TITLE_MAX))}</span></a>`;
      }
      body += `</nav>\n`;
    }
    body += `</section>\n`;
  }

  const links: string[] = [];
  if (input.chain.paths.length > 0) links.push(link(CRITICAL_PATH_PAGE, 'critical path'));
  if (input.chainExists) links.push(link('../chain.md', 'chain.md'));
  links.push(link('wk.html', 'find a work item'));
  const head = `<h1>${escapeHtml(input.repoName)} · initiatives</h1>\n${LEGEND}\n${stampLine(newest, input, links)}`;
  return pageShell({ title: `${input.repoName} · initiatives`, headHtml: head, bodyHtml: body });
}

// ---------------------------------------------------------------------------
// Chains: the critical path page and the chain page draw stages the same way
// ---------------------------------------------------------------------------

/**
 * The stages of a chain in build order: each stage's name and open count, its
 * cards in file order, and its gate; arrows between stages.
 */
function chainStages(
  ctx: BuildContext,
  chain: Chain,
  cardHref: (id: string) => string,
  cardMeta: (record: DashboardRecord) => string[],
): string {
  const stages = chain.groups.map(group => {
    let html = `<div class="section" data-stage data-name="${escapeHtml(group.name)}">\n`;
    let title = escapeHtml(group.name);
    if (group.ids.length > 0) {
      const open = group.ids.filter(id => {
        const record = ctx.byId.get(id);
        return record ? isOpenWorkItem(record.status) : false;
      }).length;
      title += `${group.name ? ' · ' : ''}<span data-open="${open}" data-total="${group.ids.length}">${open} open</span>`;
    }
    if (title) html += `<div class="section-title">${title}</div>\n`;
    if (group.ids.length > 0) {
      const cards = group.ids.map(id => {
        const record = ctx.byId.get(id);
        return record ? workCard(ctx, record, cardHref(id), cardMeta(record)) : missingCard(id);
      });
      html += `<div class="row">${cards.join('')}</div>\n`;
    } else {
      html += `<p class="empty">no work items listed</p>\n`;
    }
    if (group.gate) html += `<div class="gate" data-gate><b>Gate</b> · ${escapeHtml(group.gate)}</div>\n`;
    html += `</div>\n`;
    return html;
  });
  return stages.join('<div class="arrow-down"></div>\n');
}

// ---------------------------------------------------------------------------
// critical-path.html
// ---------------------------------------------------------------------------

function buildCriticalPath(input: PageBuildInput, ctx: BuildContext): string {
  const paths = input.chain.paths;
  const ids = paths.flatMap(p => p.groups.flatMap(g => g.ids));
  const newest = maxDate(ids.map(id => ctx.byId.get(id)?.updated));
  const single = paths.length === 1;

  let body = '';
  for (const criticalPath of paths) {
    body += `<section class="section path" data-critical-path data-heading="${escapeHtml(criticalPath.heading)}">\n`;
    if (!single) body += `<div class="section-title now">${escapeHtml(criticalPath.heading)}</div>\n`;
    body += chainStages(
      ctx,
      criticalPath,
      id => `wk.html#${id}`,
      record => (record.initiative ? [escapeHtml(record.initiative)] : []),
    );
    body += `</section>\n`;
  }

  const links = [link('index.html', 'all initiatives')];
  if (input.chainExists) links.push(link('../chain.md', 'chain.md'));
  links.push(link('wk.html', 'find a work item'));
  const subtitle = single ? `<p class="subtitle">${escapeHtml(paths[0].heading)}</p>\n` : '';
  const head = `<h1>${escapeHtml(input.repoName)} · critical path</h1>\n${subtitle}${stampLine(newest, input, links)}`;
  return pageShell({ title: `${input.repoName} · critical path`, headHtml: head, bodyHtml: body });
}

// ---------------------------------------------------------------------------
// <initiative prefix>/<ID>.html: one chain page per initiative
// ---------------------------------------------------------------------------

function lowestMilestone(tags: string[]): number | undefined {
  let lowest: number | undefined;
  for (const tag of tags) {
    const match = /^m([1-9])$/.exec(tag);
    if (!match) continue;
    const value = Number(match[1]);
    if (lowest === undefined || value < lowest) lowest = value;
  }
  return lowest;
}

function bandDepths(items: DashboardRecord[], byId: Map<string, DashboardRecord>): Map<string, number> {
  const inBand = new Set(items.map(i => i.id));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle: keep the run finite
    visiting.add(id);
    const record = byId.get(id);
    let depth = 0;
    for (const dep of record?.depends_on ?? []) {
      if (!inBand.has(dep) || dep === id) continue;
      depth = Math.max(depth, depthOf(dep) + 1);
    }
    visiting.delete(id);
    memo.set(id, depth);
    return depth;
  };

  for (const item of items) depthOf(item.id);
  return memo;
}

function compareWork(a: DashboardRecord, b: DashboardRecord): number {
  const status = statusRank(a.status) - statusRank(b.status);
  if (status !== 0) return status;
  const priority = priorityRank(a.priority) - priorityRank(b.priority);
  if (priority !== 0) return priority;
  return compareIds(a.id, b.id);
}

/** One band: rows by `depends_on` depth among the band's own work items, joined by arrows. */
function chainBand(key: string, title: string, items: DashboardRecord[], ctx: BuildContext, now: boolean): string {
  const depths = bandDepths(items, ctx.byId);
  const rows = new Map<number, DashboardRecord[]>();
  for (const record of [...items].sort(compareWork)) {
    const depth = depths.get(record.id) ?? 0;
    rows.set(depth, [...(rows.get(depth) ?? []), record]);
  }
  const rowHtml = [...rows.keys()]
    .sort((a, b) => a - b)
    .map(depth => {
      const cards = (rows.get(depth) ?? []).map(record =>
        workCard(ctx, record, `../wk.html#${record.id}`, [escapeHtml(record.itemType ?? '')]),
      );
      return `<div class="row">${cards.join('')}</div>`;
    });
  return (
    `<section class="section" data-band="${escapeHtml(key)}">` +
    `<div class="section-title${now ? ' now' : ''}">${escapeHtml(title)}</div>` +
    `${rowHtml.join('<div class="arrow-down"></div>')}</section>`
  );
}

function strip(key: string, title: string, items: DashboardRecord[]): string {
  if (items.length === 0) return '';
  const sorted = [...items].sort((a, b) => compareIds(a.id, b.id));
  const links = sorted.map(
    record =>
      `<a href="${escapeHtml(`../wk.html#${record.id}`)}" title="${escapeHtml(record.title)}">${escapeHtml(record.id)}</a>`,
  );
  return (
    `<section class="section${key === 'parked' ? ' parked' : ''}" data-strip="${escapeHtml(key)}">` +
    `<div class="section-title">${escapeHtml(title)} · ${sorted.length}</div>` +
    `<div class="parked-strip strip">${links.join(' ')}</div></section>\n`
  );
}

/** A work item the Next box can show: open and not parked; an id with no record counts. */
function isNextCandidate(record: DashboardRecord | undefined): boolean {
  return record === undefined || (isOpenWorkItem(record.status) && record.status !== 'parked');
}

function buildNext(
  input: PageBuildInput,
  ctx: BuildContext,
  initiative: DashboardRecord,
  pageWorkItems: DashboardRecord[],
): string {
  const section = input.chain.initiatives.get(initiative.id);
  const listed = section ? chainIds(section) : [];
  const openListed = listed.filter(id => isNextCandidate(ctx.byId.get(id)));

  let source: 'chain' | 'code';
  let rows: Array<{ id: string; record?: DashboardRecord }>;
  let label: string;
  let more = 0;

  if (openListed.length > 0) {
    source = 'chain';
    rows = openListed.slice(0, 7).map(id => ({ id, record: ctx.byId.get(id) }));
    more = Math.max(0, openListed.length - 7);
    label = `the first open work items of the chain in chain.md, updated ${input.chain.updated ?? 'unknown'}`;
  } else {
    const pick = pageWorkItems
      .filter(w => isNextCandidate(w))
      .filter(w => ['in_progress', 'review', 'blocked'].includes(w.status) || priorityRank(w.priority) <= 1)
      .sort(compareWork)
      .slice(0, 5);
    if (pick.length === 0) return '';
    source = 'code';
    rows = pick.map(record => ({ id: record.id, record }));
    label =
      listed.length > 0
        ? 'code-picked: every work item on the chain in chain.md is done or closed'
        : 'code-picked: chain.md has no chain for this initiative';
  }

  const stale: string[] = [];
  if (section) {
    if (!isValidDate(input.chain.updated)) {
      stale.push('chain.md has no valid updated date');
    } else {
      const chainDate = input.chain.updated;
      const newer = [initiative, ...pageWorkItems].filter(
        r => isValidDate(r.updated) && r.updated > chainDate,
      ).length;
      if (newer > 0) stale.push(`newer records than chain.md: ${newer}`);
    }
  }

  const items = rows.map(({ id, record }) => {
    if (!record) return `<li data-wk="${escapeHtml(id)}" data-status=""><b>${escapeHtml(id)}</b></li>`;
    return (
      `<li data-wk="${escapeHtml(record.id)}" data-status="${escapeHtml(record.status)}">` +
      `<b>${escapeHtml(record.id)}</b> ${escapeHtml(cutTitle(record.title, 70))} · ${escapeHtml(statusLabel(record.status))}</li>`
    );
  });
  let html = `<div class="next" data-next data-next-source="${source}"><div class="next-title">Next</div><ol>${items.join('')}</ol>`;
  if (more > 0) html += `<div class="small" data-next-more>${more} more on the chain</div>`;
  html += `<div class="small">${escapeHtml(label)}</div>`;
  if (stale.length > 0) html += `<div class="small stale" data-chain-stale>${escapeHtml(stale.join('. '))}</div>`;
  return html + `</div>\n`;
}

/** Open work items the chain does not list, so a new one is seen and placed. */
function offChain(items: DashboardRecord[]): string {
  if (items.length === 0) return '';
  const rows = [...items].sort(compareWork).map(
    record =>
      `<a class="toc-row" data-wk="${escapeHtml(record.id)}" data-status="${escapeHtml(record.status)}" href="${escapeHtml(`../wk.html#${record.id}`)}">` +
      `${dot(record.status)}<b>${escapeHtml(record.id)}</b><span>${escapeHtml(cutTitle(record.title, ROW_TITLE_MAX))}</span></a>`,
  );
  return (
    `<section class="section" data-off-chain>` +
    `<div class="section-title">Not on the chain · ${rows.length}</div>` +
    `<nav class="toc" style="grid-template-rows:repeat(${Math.ceil(rows.length / 2)},auto)">${rows.join('')}</nav></section>\n`
  );
}

/** With no chain in chain.md: bands by milestone tag, else by status. */
function codeBands(ctx: BuildContext, openish: DashboardRecord[]): string[] {
  const bands: string[] = [];
  if (openish.some(w => lowestMilestone(w.tags) !== undefined)) {
    const numbers = [...new Set(openish.map(w => lowestMilestone(w.tags)).filter((n): n is number => n !== undefined))].sort(
      (a, b) => a - b,
    );
    for (const number of numbers) {
      const items = openish.filter(w => lowestMilestone(w.tags) === number);
      bands.push(chainBand(`m${number}`, `M${number}`, items, ctx, bands.length === 0));
    }
    const unbanded = openish.filter(w => lowestMilestone(w.tags) === undefined);
    if (unbanded.length > 0) bands.push(chainBand('Unbanded', 'Unbanded', unbanded, ctx, false));
  } else {
    const groups: Array<[string, string[]]> = [
      ['In progress', ['in_progress', 'review', 'blocked']],
      ['To do', ['todo']],
      ['Inbox', ['inbox']],
    ];
    for (const [name, statuses] of groups) {
      const items = openish.filter(w => statuses.includes(w.status));
      if (items.length > 0) bands.push(chainBand(name, name, items, ctx, bands.length === 0));
    }
  }
  return bands;
}

function buildChain(input: PageBuildInput, ctx: BuildContext, initiative: DashboardRecord): string {
  const pageDir = path.dirname(path.join(ctx.generatedDir, chainPage(input, initiative.id)));
  const pageWorkItems = ctx.workItems.filter(w => w.initiative === initiative.id && !isClosedStatus(w.status));
  const done = pageWorkItems.filter(w => w.status === 'done');
  const parked = pageWorkItems.filter(w => w.status === 'parked');
  const openish = pageWorkItems.filter(w => w.status !== 'done' && w.status !== 'parked');

  let body = buildNext(input, ctx, initiative, pageWorkItems);
  body += strip('done', 'Done', done);

  const section = input.chain.initiatives.get(initiative.id);
  const listed = new Set(section ? chainIds(section) : []);
  if (section && listed.size > 0) {
    body += `<section class="section" data-chain>\n`;
    body += chainStages(
      ctx,
      section,
      id => `../wk.html#${id}`,
      record => [escapeHtml(record.itemType ?? '')],
    );
    body += `</section>\n`;
    body += offChain(openish.filter(w => !listed.has(w.id)));
  } else {
    const bands = codeBands(ctx, openish);
    if (bands.length > 0) body += bands.join('<div class="arrow-down dim"></div>') + '\n';
    else if (done.length === 0) body += `<p class="stamp">No work items name this initiative.</p>\n`;
  }
  body += strip('parked', 'Parked', parked);

  const newest = maxDate([initiative.updated, ...pageWorkItems.map(w => w.updated)]);
  const links = [
    link('../index.html', 'all initiatives'),
    link(recordHref(pageDir, initiative), `${initiative.id} record`),
  ];
  const head =
    `<h1>${escapeHtml(initiative.id)} · the chain</h1>\n` +
    `<p class="subtitle">${escapeHtml(cutTitle(initiative.title, ROW_TITLE_MAX))}</p>\n` +
    stampLine(newest, input, links);
  return pageShell({ title: `${initiative.id} · the chain`, headHtml: head, bodyHtml: body });
}

// ---------------------------------------------------------------------------
// wk.html
// ---------------------------------------------------------------------------

function sortNeighbors(ids: string[], byId: Map<string, DashboardRecord>): string[] {
  return [...ids].sort((a, b) => {
    const status = statusRank(byId.get(a)?.status) - statusRank(byId.get(b)?.status);
    if (status !== 0) return status;
    return compareIds(a, b);
  });
}

function buildWkData(input: PageBuildInput, ctx: BuildContext): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const allIds = [...ctx.byId.keys()].sort(compareIds);

  for (const id of allIds) {
    const record = ctx.byId.get(id);
    if (!record) continue;
    if (record.prefix === input.workItemPrefix && hasIdShape(id, input.workItemPrefix)) {
      const up = unique([...record.depends_on, ...ctx.recordsWhere(r => r.blocks.includes(id))]);
      const down = unique([...record.blocks, ...ctx.recordsWhere(r => r.depends_on.includes(id))]);
      const related = unique([...record.related, ...ctx.recordsWhere(r => r.related.includes(id))]);
      const drop = (ids: string[]): string[] =>
        ids.filter(other => other !== id && !isClosedStatus(ctx.byId.get(other)?.status));
      const group = (ids: string[]): string[] => sortNeighbors(unique(drop(ids)), ctx.byId).slice(0, 5);
      const dependsOn = group(up);
      const blocks = group(down);
      const rel = group(related);

      let fill: string[] = [];
      const union = unique([...dependsOn, ...blocks, ...rel]);
      if (union.length < 5 && record.initiative) {
        const candidates = ctx.workItems
          .filter(w => w.id !== id && w.initiative === record.initiative && isOpenWorkItem(w.status) && !union.includes(w.id))
          .sort((a, b) => {
            const distance = Math.abs(numericPart(a.id) - numericPart(id)) - Math.abs(numericPart(b.id) - numericPart(id));
            if (distance !== 0) return distance;
            return compareIds(a.id, b.id);
          });
        fill = candidates.slice(0, 5 - union.length).map(w => w.id);
      }

      data[id] = {
        kind: 'work',
        title: record.title,
        status: record.status,
        href: recordHref(ctx.generatedDir, record),
        priority: record.priority ?? null,
        type: record.itemType ?? null,
        updated: record.updated ?? null,
        initiative: record.initiative ?? null,
        neighbors: { dependsOn, blocks, related: rel, fill },
      };
    } else if (record.prefix === input.initiativePrefix && hasIdShape(id, input.initiativePrefix)) {
      data[id] = {
        kind: 'initiative',
        title: record.title,
        status: record.status,
        href: recordHref(ctx.generatedDir, record),
        chain: chainPage(input, record.id),
      };
    }
  }

  return data;
}

// The page script only draws: every neighbor group is computed above and embedded.
const WK_SCRIPT = `<script>
(function(){
var R=JSON.parse(document.querySelector('[data-wk-data]').textContent);
var JUMP=document.getElementById('jump');
var PREFIX=JUMP.getAttribute('data-work-prefix')||'';
var STRIPE={done:'done',in_progress:'prog',review:'prog',blocked:'blocked'};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function stripe(s){return STRIPE[s]||'todo'}
function chip(s){return '<span class="chip '+(s==='parked'?'parked':stripe(s))+'">'+esc((s||'unknown').replace(/_/g,' '))+'</span>'}
function card(id){var r=R[id];if(!r)return '<span class="tag">'+esc(id)+'</span>';
 if(r.kind==='initiative')return '<a class="card accent" href="'+esc(r.chain)+'"><div class="cid">'+esc(id)+'</div><div class="ctitle">'+esc(r.title)+'</div>'+chip(r.status)+'</a>';
 return '<a class="card '+stripe(r.status)+'" href="#'+esc(id)+'"><div class="cid">'+esc(id)+'</div><div class="ctitle">'+esc(r.title)+'</div><div class="cmeta"><span class="pri-'+esc(r.priority)+'">'+esc(r.priority)+'</span> · '+esc(r.initiative||'no initiative')+'</div>'+chip(r.status)+'</a>'}
function group(label,ids){if(!ids||!ids.length)return '';return '<div class="group-label">'+label+'</div><div class="side">'+ids.map(card).join('')+'</div>'}
function render(){var id=decodeURIComponent(location.hash.slice(1)).toUpperCase(),out=document.getElementById('out'),r=R[id];
 if(!r||r.kind!=='work'){var act=Object.keys(R).filter(function(k){return R[k].kind==='work'&&R[k].status==='in_progress'});
  out.innerHTML='<section class="section"><div class="section-title now">In progress</div><div class="side">'+(act.map(card).join('')||'<span class="empty">none</span>')+'</div></section>';
  document.getElementById('crumb').innerHTML='Type a work item id above, or pick one below.';return}
 var ini=r.initiative?R[r.initiative]:null;
 var iniHtml=!r.initiative?'<span data-wk-initiative="none">no initiative</span>':ini?'<span data-wk-initiative="'+esc(r.initiative)+'"><a href="'+esc(ini.chain)+'">'+esc(r.initiative)+'</a> · '+esc(ini.title)+'</span>':'<span data-wk-initiative="'+esc(r.initiative)+'">'+esc(r.initiative)+'</span>';
 var focus='<div class="focus"><div class="card '+stripe(r.status)+'"><div class="cid">'+esc(id)+'</div><div class="ctitle">'+esc(r.title)+'</div><div class="cmeta"><span class="pri-'+esc(r.priority)+'">'+esc(r.priority)+'</span> · '+esc(r.type)+' · updated '+esc(r.updated||'unknown')+' · <a href="'+esc(r.href)+'">open record</a></div><div class="cmeta">'+iniHtml+'</div>'+chip(r.status)+'</div></div>';
 var n=r.neighbors,h='',g;
 g=group('Depends on · blocked by',n.dependsOn);if(g)h+=g+'<div class="arrow-down"></div>';
 h+=focus;
 g=group('Blocks · needed by',n.blocks);if(g)h+='<div class="arrow-down"></div>'+g;
 g=group('Related',n.related);if(g)h+='<div class="arrow-down dim"></div>'+g;
 g=group('Same initiative, nearest ids',n.fill);if(g)h+='<div class="arrow-down dim"></div>'+g;
 out.innerHTML=h;
 document.getElementById('crumb').innerHTML='<a href="index.html">all initiatives</a>'+(ini?' · <a href="'+esc(ini.chain)+'">'+esc(r.initiative)+' chain</a>':'');
 document.title=id+' · neighbors';window.scrollTo(0,0)}
JUMP.addEventListener('keydown',function(ev){if(ev.key==='Enter'){var v=this.value.trim().toUpperCase();if(/^\\d+$/.test(v))v=PREFIX+'-'+('000'+v).slice(-4);location.hash=v}});
window.addEventListener('hashchange',render);render();
})();
</script>`;

function buildWk(input: PageBuildInput, ctx: BuildContext): string {
  const data = buildWkData(input, ctx);
  const newest = maxDate(input.records.map(r => r.updated));
  let body = `<div id="out"></div>\n`;
  body += `<script type="application/json" data-wk-data>${jsonForScript(data)}</script>\n`;
  body += WK_SCRIPT;
  const placeholder = `${input.workItemPrefix}-0001 or 1`;
  const head =
    `<h1>Work item · neighbors</h1>\n` +
    `<p class="subtitle"><input id="jump" data-wk-input data-work-prefix="${escapeHtml(input.workItemPrefix)}" placeholder="${escapeHtml(placeholder)}"></p>\n` +
    stampLine(newest, input, [], '<span id="crumb"></span> · ');
  return pageShell({ title: `${input.repoName} · work item`, headHtml: head, bodyHtml: body });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Build every generated page, keyed by its path inside the owned folder. */
export function buildPages(input: PageBuildInput): Map<string, string> {
  const generatedDir = path.join(input.targetDir, 'wiki', 'dashboard', 'generated');
  const workItems = input.records
    .filter(r => r.prefix === input.workItemPrefix && hasIdShape(r.id, input.workItemPrefix))
    .sort((a, b) => compareIds(a.id, b.id));
  const initiatives = input.records
    .filter(r => r.prefix === input.initiativePrefix && hasIdShape(r.id, input.initiativePrefix))
    .sort((a, b) => compareIds(a.id, b.id));
  const byId = new Map(input.records.map(r => [r.id, r]));

  const ctx: BuildContext = {
    generatedDir,
    byId,
    workItems,
    initiatives,
    recordsWhere: predicate => input.records.filter(predicate).map(r => r.id),
  };

  const pages = new Map<string, string>();
  pages.set('index.html', buildIndex(input, ctx));
  pages.set('wk.html', buildWk(input, ctx));
  if (input.chain.paths.length > 0) pages.set(CRITICAL_PATH_PAGE, buildCriticalPath(input, ctx));
  for (const initiative of initiatives) {
    pages.set(chainPage(input, initiative.id), buildChain(input, ctx, initiative));
  }
  return pages;
}
