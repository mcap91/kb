/**
 * A small markdown-to-HTML converter for record pages. No text from a record
 * passes through as HTML: every string is escaped, and only the forms below
 * become elements.
 *
 * Converts: headings, paragraphs, nested `-` / `*` / `1.` lists, task items,
 * fenced code, inline code, `**bold**`, `[text](target)` and `[[ID]]`.
 *
 * shortcut: tables, block quotes, raw HTML and rules show as text (table lines in
 * a preformatted block); upgrade when a user asks for rendered tables.
 */
import { escapeHtml } from './text.js';

export interface MarkdownLinks {
  /** The href of a record id, or `undefined` when no record has that id. */
  recordHref(id: string): string | undefined;
  /** A relative link target from the record file, rewritten for the page. */
  relativeHref(target: string): string;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[( |x|X)\]\s+/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const INLINE_RE = /`([^`]+)`|\[\[([^\]\s]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
  return lead.replace(/\t/g, '  ').length;
}

function isTableLine(line: string): boolean {
  return line.trimStart().startsWith('|');
}

/** Lines that start a block of their own and so end a paragraph or a list item. */
function startsBlock(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || isTableLine(line);
}

function linkTarget(target: string, links: MarkdownLinks): string | undefined {
  if (/^https?:\/\//i.test(target) || target.startsWith('#')) return target;
  if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('\\')) return undefined;
  return links.relativeHref(target);
}

/** Inline forms of one run of text; everything else is escaped text. */
export function inlineHtml(text: string, links: MarkdownLinks): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const at = match.index ?? 0;
    out += escapeHtml(text.slice(last, at));
    last = at + match[0].length;
    const [whole, code, recordId, linkText, target, bold] = match;
    if (code !== undefined) {
      out += `<code>${escapeHtml(code)}</code>`;
    } else if (recordId !== undefined) {
      const href = links.recordHref(recordId);
      out += href ? `<a href="${escapeHtml(href)}">${escapeHtml(recordId)}</a>` : escapeHtml(recordId);
    } else if (linkText !== undefined && target !== undefined) {
      const href = linkTarget(target, links);
      out += href ? `<a href="${escapeHtml(href)}">${escapeHtml(linkText)}</a>` : escapeHtml(whole);
    } else if (bold !== undefined) {
      out += `<strong>${escapeHtml(bold)}</strong>`;
    }
  }
  return out + escapeHtml(text.slice(last));
}

interface ListItem {
  indent: number;
  tag: 'ul' | 'ol';
  text: string;
}

function itemHtml(text: string, links: MarkdownLinks): string {
  const task = TASK_RE.exec(text);
  if (!task) return inlineHtml(text, links);
  const checked = task[1] !== ' ' ? ' checked' : '';
  return `<input type="checkbox" disabled${checked}> ${inlineHtml(text.slice(task[0].length), links)}`;
}

/** Nest list items by indentation: a deeper item opens a list inside the item before it. */
function listHtml(items: ListItem[], links: MarkdownLinks): string {
  const stack: Array<{ indent: number; tag: 'ul' | 'ol' }> = [];
  let html = '';
  for (const item of items) {
    while (stack.length > 0 && stack[stack.length - 1].indent > item.indent) {
      html += `</li></${stack.pop()?.tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      html += `<${item.tag}>`;
      stack.push({ indent: item.indent, tag: item.tag });
    } else if (top.tag !== item.tag) {
      html += `</li></${top.tag}><${item.tag}>`;
      stack[stack.length - 1] = { indent: item.indent, tag: item.tag };
    } else {
      html += '</li>';
    }
    html += `<li>${itemHtml(item.text, links)}`;
  }
  while (stack.length > 0) html += `</li></${stack.pop()?.tag}>`;
  return html;
}

/** Convert a record body to HTML. */
export function markdownToHtml(text: string, links: MarkdownLinks): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++; // the closing fence, when there is one
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineHtml(heading[2], links)}</h${level}>`);
      i++;
      continue;
    }

    if (isTableLine(line)) {
      const rows: string[] = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(lines[i++]);
      blocks.push(`<pre class="table">${escapeHtml(rows.join('\n'))}</pre>`);
      continue;
    }

    if (ITEM_RE.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i];
        const item = ITEM_RE.exec(current);
        if (item) {
          items.push({ indent: indentOf(current), tag: /^\d/.test(item[2]) ? 'ol' : 'ul', text: item[3] });
          i++;
          continue;
        }
        if (current.trim() === '') {
          // A blank line ends the list unless the next line is an item or an indented continuation.
          const next = lines[i + 1];
          if (next !== undefined && (ITEM_RE.test(next) || (indentOf(next) > 0 && next.trim() !== '' && !startsBlock(next)))) {
            i++;
            continue;
          }
          break;
        }
        if (startsBlock(current)) break;
        items[items.length - 1].text += ` ${current.trim()}`;
        i++;
      }
      blocks.push(listHtml(items, links));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i]) && !ITEM_RE.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    blocks.push(`<p>${inlineHtml(para.join(' '), links)}</p>`);
  }

  return blocks.join('\n');
}
