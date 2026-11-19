import * as path from 'node:path';
import type { ChainDocData } from './chain-doc.js';
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
  statusColor,
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

function stampLine(newest: string | undefined, chainExists: boolean, chainDate: string | undefined): string {
  const parts = [`Newest record update ${newest ?? 'unknown'}`];
  if (chainExists) parts.push(`chain.md updated ${chainDate ?? 'unknown'}`);
  return `${parts.join('. ')}. Generated from the wiki records and chain.md. The records win if they disagree.`;
}

function statusChip(status: string): string {
  const label = status ? status.replace(/_/g, ' ') : 'unknown';
  return `<span class="chip">${escapeHtml(label)}</span>`;
}

function statusDot(status: string): string {
  return `<span class="dot" data-color="${statusColor(status)}"></span>`;
}

interface BuildContext {
  generatedDir: string;
  byId: Map<string, DashboardRecord>;
  workItems: DashboardRecord[];
  initiatives: DashboardRecord[];
  recordsWhere(predicate: (record: DashboardRecord) => boolean): string[];
}

function recordHref(ctx: BuildContext, pageDir: string, record: DashboardRecord): string {
  return relativeHref(pageDir, record.absPath);
}

// ---------------------------------------------------------------------------
// index.html
// ---------------------------------------------------------------------------

function pathGroupRows(ctx: BuildContext, group: { ids: string[] }): string {
  return group.ids
    .map(id => {
      const record = ctx.byId.get(id);
      const href = `wk.html#${id}`;
      if (!record) {
        return `<div class="path-row" data-wk="${escapeHtml(id)}" data-status="">${statusDot('')}<span>${escapeHtml(id)}</span></div>`;
      }
      return `<div class="path-row" data-wk="${escapeHtml(id)}" data-status="${escapeHtml(record.status)}">${statusDot(record.status)}<a href="${escapeHtml(href)}"><b>${escapeHtml(id)}</b> ${escapeHtml(cutTitle(record.title, 120))}</a></div>`;
    })
    .join('\n');
}

function buildIndex(input: PageBuildInput, ctx: BuildContext): string {
  const pageDir = ctx.generatedDir;
  const newest = maxDate(input.records.map(r => r.updated));

  let body = '';
  body += `<p class="legend" data-legend>blue in progress, green done, grey to do, red blocked</p>\n`;
  body += `<p class="links">`;
  if (input.chainExists) {
    body += `<a href="../chain.md">chain.md</a> · `;
  }
  body += `<a href="wk.html">find a work item</a></p>\n`;

  for (const criticalPath of input.chain.paths) {
    body += `<section class="section" data-critical-path data-heading="${escapeHtml(criticalPath.heading)}">\n`;
    body += `<h2>${escapeHtml(criticalPath.heading)}</h2>\n`;
    for (const group of criticalPath.groups) {
      body += `<div class="band" data-path-group data-name="${escapeHtml(group.name)}">\n`;
      if (group.name) body += `<div class="band-title">${escapeHtml(group.name)}</div>\n`;
      if (group.ids.length > 0) {
        const open = group.ids.filter(id => {
          const record = ctx.byId.get(id);
          return record ? isOpenWorkItem(record.status) : false;
        }).length;
        body += `<span data-open="${open}" data-total="${group.ids.length}">${open} open</span>\n`;
      }
      if (group.gate) body += `<div class="gate" data-gate>${escapeHtml(group.gate)}</div>\n`;
      body += pathGroupRows(ctx, group);
      body += `</div>\n`;
    }
    body += `</section>\n`;
  }

  const boxes: Array<{ key: string; label: string; records: DashboardRecord[] }> = [
    {
      key: 'in-progress',
      label: 'In progress',
      records: ctx.initiatives.filter(r => ['in_progress', 'review', 'blocked'].includes(r.status)),
    },
    {
      key: 'todo',
      label: 'To do',
      records: ctx.initiatives.filter(
        r => !['in_progress', 'review', 'blocked'].includes(r.status) && r.status !== 'done' && !isClosedStatus(r.status),
      ),
    },
    {
      key: 'done',
      label: 'Done',
      records: ctx.initiatives.filter(r => r.status === 'done' || isClosedStatus(r.status)),
    },
  ];

  for (const box of boxes) {
    const rows = [...box.records].sort((a, b) => compareIds(a.id, b.id));
    body += `<section class="section" data-box="${box.key}" data-count="${rows.length}">\n`;
    body += `<div class="section-title">${box.label} · ${rows.length}</div>\n`;
    if (rows.length === 0) {
      body += `<p class="empty">none</p>\n`;
    } else {
      for (const record of rows) {
        body += `<div class="in-row" data-in="${escapeHtml(record.id)}" data-status="${escapeHtml(record.status)}">`;
        body += statusDot(record.status);
        body += `<a href="${escapeHtml(`${record.id}/chain.html`)}"><b>${escapeHtml(record.id)}</b> ${escapeHtml(cutTitle(record.title, 120))}</a>`;
        body += `</div>\n`;
      }
    }
    body += `</section>\n`;
  }

  const head = `<h1>${escapeHtml(input.repoName)} · initiatives</h1>\n<p class="stamp">${escapeHtml(stampLine(newest, input.chainExists, input.chain.updated))}</p>`;
  return pageShell({ title: `${input.repoName} · initiatives`, headHtml: head, bodyHtml: body });
}

// ---------------------------------------------------------------------------
// IN-XXXX/chain.html
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

function chainBand(
  name: string,
  items: DashboardRecord[],
  ctx: BuildContext,
): string {
  if (items.length === 0) return '';
  const depths = bandDepths(items, ctx.byId);
  const ordered = [...items].sort((a, b) => {
    const depth = (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0);
    if (depth !== 0) return depth;
    const status = statusRank(a.status) - statusRank(b.status);
    if (status !== 0) return status;
    const priority = priorityRank(a.priority) - priorityRank(b.priority);
    if (priority !== 0) return priority;
    return compareIds(a.id, b.id);
  });

  let body = `<section class="section band" data-band="${escapeHtml(name)}">\n`;
  body += `<div class="band-title">${escapeHtml(name)}</div>\n`;
  for (const record of ordered) {
    const after = record.depends_on.filter(dep => {
      const depRecord = ctx.byId.get(dep);
      return depRecord === undefined || isOpenWorkItem(depRecord.status);
    });
    const blocked = after.length > 0 && (record.status === 'todo' || record.status === 'inbox');
    body += `<a class="card" data-wk="${escapeHtml(record.id)}" data-status="${escapeHtml(record.status)}"${blocked ? ' data-blocked="true"' : ''} href="${escapeHtml(`../wk.html#${record.id}`)}">`;
    body += `<b>${escapeHtml(record.id)}</b> ${escapeHtml(record.title)}`;
    body += ` <span class="meta">${escapeHtml(record.priority ?? '')} · ${escapeHtml(record.itemType ?? '')}</span>`;
    if (after.length > 0) body += ` <span class="after">after ${escapeHtml(after.join(', '))}</span>`;
    body += ` ${statusChip(record.status)}</a>\n`;
  }
  body += `</section>\n`;
  return body;
}

function strip(name: string, items: DashboardRecord[]): string {
  if (items.length === 0) return '';
  const sorted = [...items].sort((a, b) => compareIds(a.id, b.id));
  let body = `<section class="section strip" data-strip="${escapeHtml(name)}">\n`;
  body += `<div class="section-title">${escapeHtml(name)} · ${sorted.length}</div>\n<div>`;
  for (const record of sorted) {
    body += `<a href="${escapeHtml(`../wk.html#${record.id}`)}" title="${escapeHtml(record.title)}">${escapeHtml(record.id)}</a>`;
  }
  body += `</div>\n</section>\n`;
  return body;
}

function buildChain(input: PageBuildInput, ctx: BuildContext, initiative: DashboardRecord): string {
  const pageDir = path.join(ctx.generatedDir, initiative.id);
  const pageWorkItems = ctx.workItems.filter(w => w.initiative === initiative.id && !isClosedStatus(w.status));

  const section = input.chain.initiatives.get(initiative.id);
  const hasQueue = section?.hasQueue ?? false;
  const queueIds = section?.queue ?? [];
  const queueOpen = queueIds.filter(id => {
    const record = ctx.byId.get(id);
    return record === undefined || isOpenWorkItem(record.status);
  });
  const queueDoneOrClosed = queueIds.filter(id => {
    const record = ctx.byId.get(id);
    return record !== undefined && !isOpenWorkItem(record.status);
  }).length;

  let nextHtml = '';
  let nextSource: 'chain' | 'code' | undefined;
  let nextRows: Array<{ id: string; record?: DashboardRecord }> = [];
  let nextLabel = '';
  let nextMore = 0;

  if (hasQueue && queueOpen.length > 0) {
    nextSource = 'chain';
    nextRows = queueOpen.slice(0, 7).map(id => ({ id, record: ctx.byId.get(id) }));
    nextMore = Math.max(0, queueOpen.length - 7);
    nextLabel = `from chain.md, updated ${input.chain.updated ?? 'unknown'}`;
  } else {
    const pick = pageWorkItems
      .filter(w => isOpenWorkItem(w.status))
      .filter(w => ['in_progress', 'review', 'blocked'].includes(w.status) || priorityRank(w.priority) <= 1)
      .sort((a, b) => {
        const status = statusRank(a.status) - statusRank(b.status);
        if (status !== 0) return status;
        const priority = priorityRank(a.priority) - priorityRank(b.priority);
        if (priority !== 0) return priority;
        return compareIds(a.id, b.id);
      })
      .slice(0, 5);
    if (pick.length > 0) {
      nextSource = 'code';
      nextRows = pick.map(record => ({ id: record.id, record }));
      nextLabel =
        hasQueue && queueIds.length > 0 && queueDoneOrClosed === queueIds.length
          ? 'code-picked: every chain.md line for this initiative is done or closed'
          : 'code-picked: chain.md has no In Progress or To Do list for this initiative';
    }
  }

  if (nextSource !== undefined) {
    const staleMarks: string[] = [];
    if (hasQueue) {
      if (!isValidDate(input.chain.updated)) {
        staleMarks.push('chain.md has no valid updated date');
      } else {
        const chainDate = input.chain.updated as string;
        const newerCount = [initiative, ...pageWorkItems].filter(
          r => isValidDate(r.updated) && (r.updated as string) > chainDate,
        ).length;
        if (newerCount > 0) staleMarks.push(`newer records than chain.md: ${newerCount}`);
        if (queueDoneOrClosed > 0) staleMarks.push(`chain.md names ${queueDoneOrClosed} done or closed work items`);
      }
    }

    nextHtml += `<div class="next" data-next data-next-source="${nextSource}">\n`;
    nextHtml += `<div class="next-title">Next</div>\n`;
    for (const row of nextRows) {
      if (!row.record) {
        nextHtml += `<div class="next-row" data-wk="${escapeHtml(row.id)}" data-status=""><b>${escapeHtml(row.id)}</b></div>\n`;
        continue;
      }
      nextHtml += `<div class="next-row" data-wk="${escapeHtml(row.record.id)}" data-status="${escapeHtml(row.record.status)}">`;
      nextHtml += `<b>${escapeHtml(row.record.id)}</b> ${escapeHtml(cutTitle(row.record.title, 70))} ${statusChip(row.record.status)}</div>\n`;
    }
    if (nextMore > 0) nextHtml += `<div data-next-more>${nextMore} more in chain.md</div>\n`;
    nextHtml += `<div class="next-label">${escapeHtml(nextLabel)}</div>\n`;
    if (staleMarks.length > 0) {
      nextHtml += `<div class="stale" data-chain-stale>${escapeHtml(staleMarks.join('. '))}</div>\n`;
    }
    nextHtml += `</div>\n`;
  }

  let body = '';
  body += `<p class="links"><a href="../index.html">all initiatives</a> · <a href="${escapeHtml(recordHref(ctx, pageDir, initiative))}">${escapeHtml(initiative.id)} record</a></p>\n`;
  body += nextHtml;

  const done = pageWorkItems.filter(w => w.status === 'done');
  const parked = pageWorkItems.filter(w => w.status === 'parked');
  const openish = pageWorkItems.filter(w => w.status !== 'done' && w.status !== 'parked');

  body += strip('done', done);

  const withMilestone = openish.some(w => lowestMilestone(w.tags) !== undefined);
  if (withMilestone) {
    const numbers = unique(
      openish
        .map(w => lowestMilestone(w.tags))
        .filter((n): n is number => n !== undefined)
        .map(String),
    )
      .map(Number)
      .sort((a, b) => a - b);
    for (const number of numbers) {
      body += chainBand(`m${number}`, openish.filter(w => lowestMilestone(w.tags) === number), ctx);
    }
    body += chainBand('Unbanded', openish.filter(w => lowestMilestone(w.tags) === undefined), ctx);
  } else {
    body += chainBand('In progress', openish.filter(w => ['in_progress', 'review', 'blocked'].includes(w.status)), ctx);
    body += chainBand('To do', openish.filter(w => w.status === 'todo'), ctx);
    body += chainBand('Inbox', openish.filter(w => w.status === 'inbox'), ctx);
  }

  body += strip('parked', parked);

  if (pageWorkItems.length === 0) {
    body += `<p class="empty">No work items name this initiative.</p>\n`;
  }

  const newest = maxDate([initiative.updated, ...pageWorkItems.map(w => w.updated)]);
  const head = `<h1>${escapeHtml(initiative.id)} · the chain</h1>\n<p class="subtitle">${escapeHtml(initiative.title)}</p>\n<p class="stamp">${escapeHtml(stampLine(newest, input.chainExists, input.chain.updated))}</p>`;
  return pageShell({ title: `${input.repoName} · ${initiative.id} chain`, headHtml: head, bodyHtml: body });
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
        href: recordHref(ctx, ctx.generatedDir, record),
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
        href: recordHref(ctx, ctx.generatedDir, record),
        chain: `${record.id}/chain.html`,
      };
    }
  }

  return data;
}

const WK_SCRIPT = `<script>
(function(){
var DATA=JSON.parse(document.querySelector('[data-wk-data]').textContent);
var JUMP=document.getElementById('jump');
var PREFIX=JUMP.getAttribute('data-work-prefix')||'';
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function chip(s){return '<span class="chip">'+esc((s||'unknown').replace(/_/g,' '))+'</span>'}
function card(id){var r=DATA[id];if(!r)return '<span class="meta">'+esc(id)+'</span>';
 if(r.kind==='initiative')return '<a class="card" href="'+esc(r.chain)+'"><b>'+esc(id)+'</b> '+esc(r.title)+'</a>';
 return '<a class="card" href="#'+esc(id)+'"><b>'+esc(id)+'</b> '+esc(r.title)+'</a>'}
function group(label,ids){if(!ids.length)return '';return '<div class="band-title">'+label+'</div><div class="grid">'+ids.map(card).join('')+'</div>'}
function render(){var id=decodeURIComponent(location.hash.slice(1)).toUpperCase();
 var out=document.getElementById('out');
 var r=DATA[id];
 if(!r||r.kind!=='work'){var act=Object.keys(DATA).filter(function(k){return DATA[k].kind==='work'&&DATA[k].status==='in_progress'});
  out.innerHTML='<section class="section"><div class="section-title">In progress</div><div class="grid">'+(act.map(card).join('')||'<span class="empty">none</span>')+'</div></section>';
  document.getElementById('crumb').innerHTML='Type a work item id above, or pick one below.';return}
 var ini=r.initiative?DATA[r.initiative]:null;
 var iniHtml=!r.initiative?'<span data-wk-initiative="none">no initiative</span>':ini?'<a data-wk-initiative="'+esc(r.initiative)+'" href="'+esc(ini.chain)+'">'+esc(r.initiative)+' · '+esc(ini.title)+'</a>':'<span data-wk-initiative="'+esc(r.initiative)+'">'+esc(r.initiative)+'</span>';
 var focus='<div class="card"><b>'+esc(id)+'</b> <a href="'+esc(r.href)+'">'+esc(r.title)+'</a><div class="meta">'+esc(r.priority||'')+' · '+esc(r.type||'')+' · updated '+esc(r.updated||'unknown')+'</div>'+chip(r.status)+'<div class="meta">Initiative: '+iniHtml+'</div></div>';
 var n=r.neighbors||{};
 out.innerHTML=focus+group('Depends on · blocked by',n.dependsOn||[])+group('Blocks · needed by',n.blocks||[])+group('Related',n.related||[])+group('Same initiative, nearest ids',n.fill||[]);
 document.getElementById('crumb').innerHTML='<a href="index.html">all initiatives</a>'+(ini?' · <a href="'+esc(ini.chain)+'">'+esc(r.initiative)+' chain</a>':'');
 document.title=id+' · neighbors'}
document.getElementById('jump').addEventListener('keydown',function(ev){if(ev.key==='Enter'){var v=this.value.trim().toUpperCase();if(/^\\d+$/.test(v))v=PREFIX+'-'+('000'+v).slice(-4);location.hash=v}});
window.addEventListener('hashchange',render);render();
})();
</script>`;

function buildWk(input: PageBuildInput, ctx: BuildContext): string {
  const data = buildWkData(input, ctx);
  const newest = maxDate(input.records.map(r => r.updated));
  let body = `<input id="jump" data-wk-input data-work-prefix="${escapeHtml(input.workItemPrefix)}" placeholder="id or number">\n`;
  body += `<div id="out"></div>\n`;
  body += `<script type="application/json" data-wk-data>${jsonForScript(data)}</script>\n`;
  body += WK_SCRIPT;
  const head = `<h1>${escapeHtml(input.repoName)} · work item</h1>\n<p class="stamp"><span id="crumb"></span> · ${escapeHtml(stampLine(newest, input.chainExists, input.chain.updated))}</p>`;
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
  for (const initiative of initiatives) {
    pages.set(`${initiative.id}/chain.html`, buildChain(input, ctx, initiative));
  }
  return pages;
}
