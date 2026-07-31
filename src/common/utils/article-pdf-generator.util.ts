// ════════════════════════════════════════════════════════════
// CURRENT AFFAIRS — ARTICLE PDF GENERATOR
// ════════════════════════════════════════════════════════════
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { join } from 'path';
import { parseDocument } from 'htmlparser2';
import type { Response } from 'express';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

export interface ArticlePdfData {
  title: string;
  summary?: string;
  category: string;
  date: string;
  source?: string | null;
  tags?: string[];
  fullContentHtml: string;
  // Optional pre-parsed sections — when present, rendered as colour-coded
  // boxes that mirror the Android WebView section-block style.
  keyPointsHtml?:       string | null;
  majorIssuesHtml?:     string | null;
  govtInitiativesHtml?: string | null;
  biharSpecificHtml?:   string | null;
  examRelevanceHtml?:   string | null;   // rendered as "Value Addition"
  wayForwardHtml?:      string | null;
  quotesHtml?:          string | null;
  importantFactsHtml?:  string | null;   // legacy, retired from the admin form
}

// ── Palette (mirrors RichContentView.tsx admin + app WebView CSS) ──────
const INK         = '#1E293B';   // body text
const MUTED       = '#64748B';   // secondary / meta text
const BRAND       = '#1565C0';   // headings, links, category chip
const BRAND_LIGHT = '#E8F1FC';   // table header bg
const ACCENT      = '#0A2472';   // page header chip bg
const BORDER      = '#CBD5E1';   // horizontal rules, table borders
const HIGHLIGHT_DEFAULT = '#FEF9C3'; // fallback highlight (yellow)
const PAGE_MARGIN = 48;
const BODY_SIZE   = 11.5;        // pt — slightly larger = more readable on A4

interface Style {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  color?: string; highlight?: string; link?: string;
}
interface Run { text: string; style: Style }
interface RenderCtx { contentX: number; contentWidth: number; imageMap: Map<string, Buffer> }

// ── Font helpers ────────────────────────────────────────────
function fontFor(s: Style): string {
  if (s.bold && s.italic) return 'Helvetica-BoldOblique';
  if (s.bold)   return 'Helvetica-Bold';
  if (s.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

// ── Color helpers ────────────────────────────────────────────
// Both the sanitizer regex and TipTap can produce rgb() or rgba(); convert
// to the [r,g,b] array form PDFKit always handles correctly.
function toPdfColor(c: string | undefined): string | number[] {
  if (!c) return INK;
  const s = c.trim();
  if (s.startsWith('#')) return s;
  const m = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/.exec(s);
  if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  return s; // named colour — PDFKit knows standard CSS names
}

function extractStyleColor(attr?: string): string | undefined {
  if (!attr) return undefined;
  const m = /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/.exec(attr);
  return m ? m[1].trim() : undefined;
}
function extractBgColor(attr?: string): string | undefined {
  if (!attr) return undefined;
  const m = /background-color\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/.exec(attr);
  return m ? m[1].trim() : undefined;
}
function extractWidthPct(attr?: string): number | undefined {
  if (!attr) return undefined;
  const m = /width\s*:\s*(\d+(?:\.\d+)?)%/.exec(attr);
  return m ? parseFloat(m[1]) : undefined;
}
function extractAlign(attr?: string): 'left' | 'center' | 'right' {
  if (!attr) return 'left';
  const m = /margin\s*:\s*([^;]+)/.exec(attr);
  if (!m) return 'left';
  const parts = m[1].trim().split(/\s+/);
  if (parts.length === 2 && parts[1] === 'auto') return 'center';
  if (parts.length === 4 && parts[3] === 'auto' && parts[1] !== 'auto') return 'right';
  return 'left';
}
function collapseWs(t: string): string { return t.replace(/[\t\r\n ]+/g, ' '); }
function safeFileName(title: string): string {
  return (title || 'article').replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().slice(0, 80) || 'article';
}
// Strip HTML tags to plain text for use in plain-text PDF fields (title, source)
function stripHtmlForPdf(html: string): string {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// ── HTML → styled run list ────────────────────────────────────────────────
function flattenRuns(nodes: any[], style: Style, runs: Run[] = []): Run[] {
  for (const node of nodes || []) {
    if (node.type === 'text') {
      const t = collapseWs(node.data || '');
      if (t) runs.push({ text: t, style });
      continue;
    }
    if (node.type !== 'tag') continue;
    const a = node.attribs || {};
    switch (node.name) {
      case 'strong': case 'b':
        flattenRuns(node.children, { ...style, bold: true }, runs); break;
      case 'em': case 'i':
        flattenRuns(node.children, { ...style, italic: true }, runs); break;
      case 'u':
        flattenRuns(node.children, { ...style, underline: true }, runs); break;
      case 's': case 'del': case 'strike':
        flattenRuns(node.children, { ...style, strike: true }, runs); break;
      case 'a':
        flattenRuns(node.children,
          { ...style, color: style.color || BRAND, underline: true, link: a.href },
          runs);
        break;
      case 'span': case 'mark': {
        const color = extractStyleColor(a.style);
        const bg    = extractBgColor(a.style) ?? (node.name === 'mark' ? HIGHLIGHT_DEFAULT : undefined);
        flattenRuns(node.children,
          { ...style,
            color:     color ?? style.color,
            highlight: bg    ?? style.highlight },
          runs);
        break;
      }
      case 'br':
        runs.push({ text: '\n', style }); break;
      default:
        flattenRuns(node.children, style, runs);
    }
  }
  return runs;
}

function trimRuns(runs: Run[]): Run[] {
  if (!runs.length) return runs;
  const out = runs.map(r => ({ ...r }));
  out[0].text = out[0].text.replace(/^\s+/, '');
  out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  return out.filter(r => r.text.length > 0);
}

// ── Core renderer: mixed-style inline text ────────────────────────────────
// Uses PDFKit's `continued` mode for same-line runs. First run receives
// explicit x,y so position is always anchored regardless of prior state.
function emitRuns(doc: any, runs: Run[], size: number, x: number, width: number) {
  if (!runs.length) return;
  const y0 = doc.y;
  runs.forEach((run, i) => {
    const isLast = i === runs.length - 1;
    // FIX: the highlight rect used to anchor to doc.x/doc.y unconditionally.
    // For the FIRST run in a batch, doc.x/doc.y is the STALE cursor left
    // over from whatever was rendered immediately before (a heading, table,
    // bullet marker, etc.) — not where this run's text is about to be
    // placed (that's the explicit (x, y0) used a few lines below for the
    // actual doc.text() call). This mismatch is why highlight/marker boxes
    // showed up in the wrong place relative to the text they should cover.
    const runX = i === 0 ? x : doc.x;
    const runY = i === 0 ? y0 : doc.y;

    // Highlight background drawn BEFORE text, same row
    if (run.style.highlight && run.text.trim()) {
      const tw = doc.widthOfString(run.text, { font: fontFor(run.style), size });
      doc.save()
        .fillColor(toPdfColor(run.style.highlight))
        .fillOpacity(0.82)
        .rect(runX, runY + 1.5, tw, size * 1.3)
        .fill()
        .restore();
      doc.fillOpacity(1);
    }

    doc.font(fontFor(run.style))
       .fontSize(size)
       .fillColor(run.style.color ? toPdfColor(run.style.color) : INK);

    const opts: any = {
      continued: !isLast,
      underline: !!run.style.underline,
      strike:    !!run.style.strike,
      link:      run.style.link || undefined,
      width,
    };
    if (i === 0) doc.text(run.text, x, y0, opts);
    else         doc.text(run.text, opts);
  });
}

// ── Page-space guard ──────────────────────────────────────────────────────
function ensureSpace(doc: any, needed: number) {
  const freshTop = doc.page.margins.top + 80;
  if (doc.y < freshTop) return; // already near top of a new page
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

// ── Block renderers ───────────────────────────────────────────────────────
function renderHeading(doc: any, el: any, ctx: RenderCtx, size: number) {
  const runs = trimRuns(flattenRuns(el.children, { bold: true }));
  if (!runs.length) return;
  ensureSpace(doc, size * 2.5);
  doc.moveDown(0.5);
  // Give headings the brand blue unless an explicit colour span overrides
  runs.forEach(r => { if (!r.style.color) r.style.color = BRAND; });
  emitRuns(doc, runs, size, ctx.contentX, ctx.contentWidth);
  doc.moveDown(0.3);
  doc.x = ctx.contentX;
}

function renderParagraph(doc: any, el: any, ctx: RenderCtx) {
  const runs = trimRuns(flattenRuns(el.children, {}));
  if (!runs.length) return;
  ensureSpace(doc, BODY_SIZE * 3);
  emitRuns(doc, runs, BODY_SIZE, ctx.contentX, ctx.contentWidth);
  doc.moveDown(0.55);
  doc.x = ctx.contentX;
}

function renderBlockquote(doc: any, el: any, ctx: RenderCtx) {
  const x = ctx.contentX + 18;
  const w = ctx.contentWidth - 18;
  const blocks = (el.children || []).filter((c: any) => c.type === 'tag' && c.name === 'p');
  const paragraphs = blocks.length ? blocks : [{ children: el.children }];
  // ensureSpace FIRST — if it adds a page, startY must be on the NEW page
  ensureSpace(doc, 40);
  const startY = doc.y;
  const approxH = paragraphs.length * BODY_SIZE * 3.5 + 16;
  doc.save().fillColor(BRAND_LIGHT).fillOpacity(0.55)
    .roundedRect(ctx.contentX, startY - 2, ctx.contentWidth, approxH, 4)
    .fill().restore();
  doc.fillOpacity(1);
  for (const p of paragraphs) {
    const runs = trimRuns(flattenRuns(p.children, { italic: true, color: MUTED }));
    if (!runs.length) continue;
    emitRuns(doc, runs, BODY_SIZE, x, w);
    doc.moveDown(0.3);
  }
  const endY = doc.y;
  doc.save().fillColor(BRAND)
    .rect(ctx.contentX, startY - 2, 3.5, Math.max(8, endY - startY + 8))
    .fill().restore();
  doc.moveDown(0.5);
  doc.x = ctx.contentX;
}

// Tags that must NOT be flattened into inline text inside a <li>.
// Without this, a <table> inside <li> causes flattenRuns to concatenate
// all its cell text into one continuous run → the corrupt line shown in PDFs.
const BLOCK_IN_LI = new Set(['ul','ol','table','blockquote','img','figure','div','h1','h2','h3','h4','p']);

function renderList(doc: any, items: any[], ctx: RenderCtx, ordered: boolean, depth: number) {
  let idx = 1;
  for (const li of items || []) {
    if (li.type !== 'tag' || li.name !== 'li') continue;
    const indent = depth * 18;
    const x = ctx.contentX + indent + 16;
    const w = ctx.contentWidth - indent - 16;
    ensureSpace(doc, BODY_SIZE * 2);
    const marker = ordered ? `${idx}.` : '•';
    idx++;
    // Bullet / number
    doc.font('Helvetica').fontSize(BODY_SIZE).fillColor(BRAND)
      .text(marker, ctx.contentX + indent, doc.y, { width: 14, continued: false });
    doc.moveUp(1);
    // Inline-only children — excludes tables, nested lists, blockquotes etc.
    const ownKids = (li.children || []).filter(
      (c: any) => !(c.type === 'tag' && BLOCK_IN_LI.has(c.name))
    );
    const runs = trimRuns(flattenRuns(ownKids, {}));
    if (runs.length) {
      emitRuns(doc, runs, BODY_SIZE, x, w);
    } else {
      doc.moveDown(1); // step past bullet when <li> has no inline text
    }
    doc.moveDown(0.3);
    // Block-level children rendered as full blocks below the list item text
    for (const sub of li.children || []) {
      if (sub.type !== 'tag') continue;
      if (sub.name === 'ul') renderList(doc, sub.children, ctx, false, depth + 1);
      else if (sub.name === 'ol') renderList(doc, sub.children, ctx, true, depth + 1);
      // FIX: was rendered with the outer (un-indented, full-width) ctx, so an
      // image/table/blockquote nested inside a bullet point rendered flush
      // against the page's left margin instead of scoped under the bullet —
      // now uses the same indented x/w already computed for this <li>.
      else if (BLOCK_IN_LI.has(sub.name)) renderNodes(doc, [sub], { ...ctx, contentX: x, contentWidth: w });
    }
  }
  doc.moveDown(0.2);
  doc.x = ctx.contentX;
}

function renderTable(doc: any, tableEl: any, ctx: RenderCtx) {
  const rows: { cells: any[]; isHeader: boolean }[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes || []) {
      if (n.type !== 'tag') continue;
      if (n.name === 'thead' || n.name === 'tbody') { walk(n.children); continue; }
      if (n.name === 'tr') {
        const cells = (n.children || []).filter(
          (c: any) => c.type === 'tag' && (c.name === 'td' || c.name === 'th')
        );
        if (cells.length) rows.push({ cells, isHeader: cells.some((c: any) => c.name === 'th') });
      }
    }
  };
  walk(tableEl.children);
  if (!rows.length) return;

  const numCols = Math.max(...rows.map(r => r.cells.length));
  if (!numCols) return;
  const colW = ctx.contentWidth / numCols;
  const pX = 7, pY = 5;

  for (const row of rows) {
    const texts = row.cells.map((c: any) =>
      trimRuns(flattenRuns(c.children, {})).map(r => r.text).join('')
    );
    const cellSize = row.isHeader ? 9.5 : 9;
    let rowH = 0;
    texts.forEach(t => {
      const h = doc.heightOfString(t || ' ', {
        width: colW - pX * 2,
        font:  row.isHeader ? 'Helvetica-Bold' : 'Helvetica',
        size:  cellSize,
      });
      rowH = Math.max(rowH, h);
    });
    rowH = Math.max(rowH + pY * 2, 22);
    ensureSpace(doc, rowH + 4);

    const ry = doc.y;
    if (row.isHeader) {
      doc.save().fillColor(BRAND).fillOpacity(1)
        .rect(ctx.contentX, ry, ctx.contentWidth, rowH).fill().restore();
    }
    row.cells.forEach((_: any, ci: number) => {
      const cx = ctx.contentX + ci * colW;
      doc.save().strokeColor(row.isHeader ? BRAND : BORDER).lineWidth(0.5)
        .rect(cx, ry, colW, rowH).stroke().restore();
      doc.font(row.isHeader ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(cellSize)
         .fillColor(row.isHeader ? '#FFFFFF' : INK)
         .text(texts[ci] || '', cx + pX, ry + pY, { width: colW - pX * 2 });
    });
    doc.y = ry + rowH;
    doc.x = ctx.contentX;
  }
  doc.moveDown(0.7);
}

function renderImage(doc: any, el: any, ctx: RenderCtx) {
  const src = el.attribs?.src;
  const buf = src ? ctx.imageMap.get(src) : undefined;
  if (!buf) return;
  let img: any;
  try { img = doc.openImage(buf); } catch { return; }

  const pct    = extractWidthPct(el.attribs?.style) ?? 100;
  const align  = extractAlign(el.attribs?.style);
  let targetW = Math.min(ctx.contentWidth, ctx.contentWidth * pct / 100);
  let targetH = img.height * (targetW / img.width);

  // FIX: ensureSpace() used to be capped at 200pt regardless of the image's
  // real height, so a tall image near the bottom of a page never triggered a
  // page break — PDFKit doesn't clip, so it just got drawn straight off the
  // bottom edge (the overflow portion effectively lost). Now: if the image is
  // taller than a full page's usable height, scale it down first (preserving
  // aspect ratio) so it always fits within a single page, then check space
  // using its real (possibly scaled-down) height.
  const maxPageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 20;
  if (targetH > maxPageH) {
    const scale = maxPageH / targetH;
    targetH = maxPageH;
    targetW = targetW * scale;
  }
  ensureSpace(doc, targetH);

  let imgX = ctx.contentX;
  if (align === 'center') imgX = ctx.contentX + (ctx.contentWidth - targetW) / 2;
  else if (align === 'right')  imgX = ctx.contentX + ctx.contentWidth - targetW;

  // FIX: doc.image() can throw for a malformed-but-openable buffer. This runs
  // mid-stream (after headers/piping already started), so an uncaught throw
  // here used to silently truncate/hang the download with no clean error.
  try {
    doc.image(img, imgX, doc.y, { width: targetW });
  } catch (err: any) {
    console.error(`Article PDF: failed to draw image ${src}: ${err?.message}`);
    return;
  }
  doc.y += targetH + 10;
  doc.x = ctx.contentX;
}

function renderNodes(doc: any, nodes: any[], ctx: RenderCtx) {
  for (const node of nodes || []) {
    if (node.type !== 'tag') continue;
    switch (node.name) {
      case 'h1': renderHeading(doc, node, ctx, 17);   break;
      case 'h2': renderHeading(doc, node, ctx, 14.5); break;
      case 'h3': renderHeading(doc, node, ctx, 12.5); break;
      case 'p':  renderParagraph(doc, node, ctx);     break;
      case 'blockquote': renderBlockquote(doc, node, ctx); break;
      case 'ul': renderList(doc, node.children, ctx, false, 0); break;
      case 'ol': renderList(doc, node.children, ctx, true,  0); break;
      case 'table': renderTable(doc, node, ctx); break;
      case 'img':   renderImage(doc, node, ctx); break;
      case 'hr':
        doc.moveDown(0.4);
        doc.moveTo(ctx.contentX, doc.y).lineTo(ctx.contentX + ctx.contentWidth, doc.y)
          .strokeColor(BORDER).lineWidth(0.75).stroke();
        doc.moveDown(0.6);
        doc.x = ctx.contentX;
        break;
      default: renderNodes(doc, node.children, ctx);
    }
  }
}

// ── Section-block renderer ────────────────────────────────────────────────
// Mirrors the Android WebView .section-block CSS:
//   key-points      → blue   #1565C0 / bg #F0F7FF
//   exam-relevance  → orange #E65100 / bg #FFF8E6
//   important-facts → green  #2E7D32 / bg #F3F9F3
interface SectionBlockSpec {
  label: string;
  accentColor: string;   // border + label text
  bgColor:     string;   // background fill
}
const SECTION_SPECS: Record<string, SectionBlockSpec> = {
  keyPoints:      { label: '🔑  KEY POINTS',                 accentColor: '#1565C0', bgColor: '#F0F7FF' },
  majorIssues:    { label: '⚠️  MAJOR ISSUES & CHALLENGES',  accentColor: '#C62828', bgColor: '#FDF2F2' },
  govtInitiatives:{ label: '🏛️  GOVERNMENT INITIATIVES',     accentColor: '#00695C', bgColor: '#EFF7F6' },
  biharSpecific:  { label: '📍  BIHAR SPECIFIC',             accentColor: '#6A1B9A', bgColor: '#F7F1FA' },
  // exam_relevance is relabelled "Value Addition" — same column, same content.
  examRelevance:  { label: '🎯  VALUE ADDITION',             accentColor: '#E65100', bgColor: '#FFF8E6' },
  wayForward:     { label: '🛤️  WAY FORWARD & CONCLUSION',   accentColor: '#283593', bgColor: '#F1F3FB' },
  quotes:         { label: '❝  QUOTES',                      accentColor: '#455A64', bgColor: '#F4F6F7' },
  importantFacts: { label: '📊  IMPORTANT FACTS & FIGURES',   accentColor: '#2E7D32', bgColor: '#F3F9F3' },
};

function renderSectionBlock(
  doc: any,
  html: string,
  specKey: keyof typeof SECTION_SPECS,
  ctx: RenderCtx,
) {
  if (!html?.trim()) return;
  const spec = SECTION_SPECS[specKey];
  const innerX = ctx.contentX + 14;
  const innerW = ctx.contentWidth - 14;

  ensureSpace(doc, 60);

  // FIX: this function used to unconditionally render the section's content
  // TWICE (once to measure its height, once "on top" of a background box —
  // a fake z-index trick, since PDFKit draws strictly in stream order). That
  // only produces a correct result when the whole section fits on a single
  // page. The moment keyPoints/examRelevance/importantFacts HTML is long
  // enough to trigger a page break during the first pass, contentEndY lands
  // on a DIFFERENT page than blockStartY (so the computed height is garbage),
  // and doc.y = contentStartY resets a page-1-relative Y coordinate while
  // PDFKit is still sitting on whatever page the first pass ended on — the
  // second pass then re-renders the ENTIRE section a second time starting
  // mid-page, roughly doubling that section's page count and leaving
  // mangled/blank pages behind. This is what turned a 30-page article into
  // ~60 pages. Fix: render the content exactly ONCE, then only attempt the
  // "box behind text" redraw trick when we can prove (via buffered page
  // index) that no page break occurred. If it spans multiple pages, decorate
  // each touched page with a left accent bar instead — no exact bounds
  // needed, no second render pass, so the content itself is never duplicated.
  const startPageIdx = doc.bufferedPageRange().count - 1;

  // Snapshot Y before rendering content so we can draw the background box behind it
  const blockStartY = doc.y;
  const LABEL_H = 20;

  // ── Label ──
  doc.moveDown(0.15);
  const labelY = doc.y;
  doc.font('Helvetica-Bold').fontSize(8)
    .fillColor(spec.accentColor)
    .text(spec.label, innerX, labelY + 4, { width: innerW, lineBreak: false });
  doc.y = labelY + LABEL_H;
  doc.x = innerX;

  // ── Content — rendered exactly once ──
  const contentStartY = doc.y;
  const dom = parseDocument(html);
  renderNodes(doc, dom.children as any[], { ...ctx, contentX: innerX, contentWidth: innerW });
  const contentEndY = doc.y;
  const endPageIdx = doc.bufferedPageRange().count - 1;

  if (endPageIdx === startPageIdx) {
    // Single page — blockStartY and contentEndY are on the same page, so the
    // height is trustworthy. Safe to draw the background box behind the
    // content and redraw the (short, page-confined) content on top.
    const totalH = contentEndY - blockStartY + 10;
    doc.save()
      .fillColor(spec.bgColor).fillOpacity(0.7)
      .roundedRect(ctx.contentX, blockStartY - 4, ctx.contentWidth, totalH, 4)
      .fill()
      .restore();
    doc.save()
      .fillColor(spec.accentColor).fillOpacity(1)
      .rect(ctx.contentX, blockStartY - 4, 3.5, totalH)
      .fill()
      .restore();

    doc.font('Helvetica-Bold').fontSize(8).fillColor(spec.accentColor)
      .text(spec.label, innerX, labelY + 4, { width: innerW, lineBreak: false });
    doc.y = contentStartY;
    doc.x = innerX;
    renderNodes(doc, dom.children as any[], { ...ctx, contentX: innerX, contentWidth: innerW });
  } else {
    // Multi-page — content is already correctly rendered (single pass), so it
    // must NOT be redrawn. Decorate each touched page with a left accent bar
    // (no background tint, since its exact per-page horizontal bounds aren't
    // knowable without a second pass). switchToPage() moves doc's cursor, so
    // save the real end position first and restore it once done.
    const savedY = doc.y;
    const savedX = doc.x;
    for (let i = startPageIdx; i <= endPageIdx; i++) {
      doc.switchToPage(i);
      const top    = i === startPageIdx ? blockStartY - 4 : doc.page.margins.top;
      const bottom = i === endPageIdx   ? contentEndY      : doc.page.height - doc.page.margins.bottom;
      doc.save()
        .fillColor(spec.accentColor).fillOpacity(1)
        .rect(ctx.contentX, top, 3.5, Math.max(8, bottom - top))
        .fill()
        .restore();
    }
    doc.switchToPage(endPageIdx);
    doc.y = savedY;
    doc.x = savedX;
  }

  doc.moveDown(0.6);
  doc.x = ctx.contentX;
}


function collectImageSrcs(nodes: any[], acc: string[] = []): string[] {
  for (const node of nodes || []) {
    if (node.type !== 'tag') continue;
    if (node.name === 'img' && node.attribs?.src) acc.push(node.attribs.src);
    if (node.children) collectImageSrcs(node.children, acc);
  }
  return acc;
}
function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`)); return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function loadImageBuffer(src: string, uploadDir: string): Promise<Buffer | null> {
  try {
    const idx = src.indexOf('/uploads/');
    if (idx !== -1) {
      const rel  = src.substring(idx + '/uploads/'.length);
      const path = join(uploadDir, rel);
      if (fs.existsSync(path)) return fs.readFileSync(path);
    }
  } catch (_) {}
  return fetchBuffer(src).catch(() => null);
}

// ── Logo cache ────────────────────────────────────────────────────────────
const LOGO_PATHS = [
  join(__dirname, 'logo.png'),                       // dist/common/utils/logo.png (via nest-cli.json assets)
  join(__dirname, '../../assets/logo.png'),           // dist/assets/logo.png
  join(process.cwd(), 'src', 'assets', 'logo.png'),  // dev / ts-node
  join(process.cwd(), 'src', 'assets', 'logo.jpg'),
  join(process.cwd(), 'uploads', 'logo.png'),         // VPS volume — always works
  join(process.cwd(), 'uploads', 'logo.jpg'),
];
let _logo: Buffer | null | undefined;
function loadLogo(): Buffer | null {
  if (_logo !== undefined) return _logo;
  for (const p of LOGO_PATHS) {
    try { if (fs.existsSync(p)) { _logo = fs.readFileSync(p); return _logo; } }
    catch (_) {}
  }
  _logo = null;
  return null;
}

// ── Page chrome ───────────────────────────────────────────────────────────
function drawWatermark(doc: any, logo?: Buffer) {
  const { width, height } = doc.page;
  doc.save();
  doc.fillOpacity(0.06);
  if (logo) {
    try {
      const img  = doc.openImage(logo);
      const maxW = width * 0.32;
      const maxH = height * 0.32;
      const sc   = Math.min(maxW / img.width, maxH / img.height);
      const iw   = img.width  * sc;
      const ih   = img.height * sc;
      doc.image(img, (width - iw) / 2, (height - ih) / 2, { width: iw, height: ih });
    } catch (_) {
      // corrupt / unsupported — fall through to text
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(28)
        .text('BPSCNotes', 0, height / 2 - 20, { width, align: 'center' });
    }
  } else {
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(28)
      .text('BPSCNotes', 0, height / 2 - 20, { width, align: 'center' });
    doc.fontSize(11)
      .text('www.bpscnotes.in', 0, height / 2 + 18, { width, align: 'center' });
  }
  doc.restore();
}

// FIX: the only existing "logo" was drawWatermark() above — a huge, 6%-opacity
// background image, effectively invisible as branding. This is a real, opaque
// header banner (logo thumbnail + app name) drawn in the top margin band on
// EVERY page, which is what was actually requested. It's drawn within
// y < doc.page.margins.top so it never overlaps the article content, which
// always starts at doc.y >= margins.top.
function drawPageHeader(doc: any, logo: Buffer | undefined, appName: string) {
  const { width, margins } = doc.page;
  const logoSize = 20;
  const y = 12;
  doc.save();
  doc.fillOpacity(1);
  let textX = margins.left;
  if (logo) {
    try {
      const img = doc.openImage(logo);
      const sc  = logoSize / Math.max(img.width, img.height);
      const iw  = img.width  * sc;
      const ih  = img.height * sc;
      doc.image(img, margins.left, y, { width: iw, height: ih });
      textX = margins.left + iw + 8;
    } catch (_) {
      // corrupt / unsupported — fall through to text-only header
    }
  }
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(11)
    .text(appName, textX, y + logoSize / 2 - 5, { width: width - textX - margins.right, lineBreak: false });
  doc.moveTo(margins.left, y + logoSize + 4).lineTo(width - margins.right, y + logoSize + 4)
    .strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.restore();
}

function drawFooter(doc: any, pageNum: number, totalPages: number) {
  const { width, height, margins } = doc.page;
  doc.save();
  doc.fillOpacity(1).fillColor(MUTED).font('Helvetica').fontSize(8);
  doc.text(
    `BPSC Notes  ·  bpscnotes.in  ·  Page ${pageNum} of ${totalPages}`,
    margins.left, height - margins.bottom + 14,
    { width: width - margins.left - margins.right, align: 'center' }
  );
  doc.restore();
}

// ── Article header ────────────────────────────────────────────────────────
// Layout (top → bottom):
//   [■ CATEGORY]                     category chip with brand bg
//   Article Headline Title           bold, INK, large
//   DD Month YYYY  ·  Source: ...    small, muted
//   Summary lead paragraph           italic, muted (if present)
//   ────────────────────────────────  divider
function drawHeader(doc: any, data: ArticlePdfData, contentWidth: number) {
  const x = PAGE_MARGIN;

  // Category chip
  const cat = (data.category || 'General').toUpperCase();
  const catW = doc.widthOfString(cat, { font: 'Helvetica-Bold', size: 8 }) + 16;
  doc.save()
    .fillColor(ACCENT)
    .roundedRect(x, doc.y, catW, 16, 3)
    .fill()
    .restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF')
    .text(cat, x + 8, doc.y + 4, { width: catW, lineBreak: false });
  doc.y += 22;
  doc.x = x;

  // Title
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20)
    .text(data.title, x, doc.y, { width: contentWidth });
  doc.moveDown(0.4);

  // Date + source meta line
  let dateStr = data.date;
  try {
    dateStr = new Date(data.date).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch (_) {}
  const meta = `${dateStr}${data.source ? '   ·   Source: ' + data.source : ''}`;
  doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
    .text(meta, x, doc.y, { width: contentWidth });
  doc.moveDown(0.6);

  // Summary — shown as a styled lead paragraph below the date line.
  // Uses plain-text extraction (stripHtmlForPdf) rather than the full
  // HTML→runs pipeline so it always renders regardless of how TipTap
  // serialises the inline marks. Rich inline styling is kept for the WebView;
  // the PDF shows the text content clearly which is what matters here.
  const plainSummary = stripHtmlForPdf(data.summary || '').trim();
  if (plainSummary) {
    const summH = doc.heightOfString(plainSummary, {
      font: 'Helvetica-Oblique', size: BODY_SIZE, width: contentWidth - 24,
    }) + 20;
    doc.save().fillColor(BRAND_LIGHT).fillOpacity(0.55)
      .roundedRect(x, doc.y, contentWidth, summH, 4)
      .fill().restore();
    doc.fillOpacity(1);
    doc.save().fillColor(BRAND)
      .rect(x, doc.y, 3, summH)
      .fill().restore();
    doc.font('Helvetica-Oblique').fontSize(BODY_SIZE).fillColor(MUTED)
      .text(plainSummary, x + 12, doc.y + 10, { width: contentWidth - 24 });
    doc.moveDown(0.6);
  }

  // Divider
  doc.moveTo(x, doc.y).lineTo(x + contentWidth, doc.y)
    .strokeColor(BORDER).lineWidth(1).stroke();
  doc.moveDown(0.9);
  doc.x = x;
}

function drawTagsFooter(doc: any, data: ArticlePdfData, contentWidth: number) {
  if (!data.tags?.length) return;
  doc.moveDown(0.7);
  doc.moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + contentWidth, doc.y)
    .strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.moveDown(0.45);
  doc.fillColor(BRAND).font('Helvetica').fontSize(9)
    .text(data.tags.map(t => `#${t}`).join('   '), PAGE_MARGIN, doc.y, {
      width: contentWidth,
    });
}

// ── Public entry point ────────────────────────────────────────────────────
export async function streamArticlePdf(
  res: Response,
  data: ArticlePdfData,
  uploadDir: string,
): Promise<void> {
  // Title/source are inline-HTML from TipTap — strip for plain-text PDFKit fields
  const plainTitle  = stripHtmlForPdf(data.title);
  const plainSource = data.source ? stripHtmlForPdf(data.source) : undefined;

  // Clean up trailing TipTap empty paragraphs
  const raw = (data.fullContentHtml || '')
    .replace(/(<p>\s*<\/p>\s*){2,}/gi, '<p></p>')
    .replace(/(<p>\s*<\/p>\s*)+$/gi,   '');

  // Wrap plain-text articles (created before TipTap was added) in <p> tags
  const hasHtml   = /<[a-z][\s\S]*?>/i.test(raw);
  const cleanHtml = hasHtml
    ? raw
    : raw.split(/\n+/).filter(l => l.trim()).map(l => `<p>${l}</p>`).join('');

  const dom       = parseDocument(cleanHtml);
  const imageSrcs = collectImageSrcs(dom.children as any[]);
  const imageMap  = new Map<string, Buffer>();
  await Promise.all(imageSrcs.map(async (src) => {
    const buf = await loadImageBuffer(src, uploadDir);
    if (buf) imageMap.set(src, buf);
  }));

  const logo = loadLogo() ?? undefined;

  const doc = new PDFDocument({
    size:         'A4',
    margin:       PAGE_MARGIN,
    bufferPages:  true,
    info: {
      Title:   plainTitle,
      Author:  'BPSCNotes',
      Subject: data.category || 'Current Affairs',
    },
  });
  const cw = doc.page.width - PAGE_MARGIN * 2;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(plainTitle)}.pdf"`);
  doc.pipe(res);
  // FIX: neither the response stream nor the pdfkit document had an error
  // listener — an unhandled mid-stream error (e.g. client disconnects on a
  // mobile network drop) would surface as an unhandled rejection instead of
  // being logged/cleaned up.
  res.on('error', (err: any) => console.error(`Article PDF: response stream error: ${err?.message}`));
  doc.on('error', (err: any) => console.error(`Article PDF: pdfkit stream error: ${err?.message}`));

  drawHeader(doc, { ...data, title: plainTitle, source: plainSource }, cw);

  const ctx: RenderCtx = { contentX: PAGE_MARGIN, contentWidth: cw, imageMap };

  // ── Render in the same order as the Android WebView buildArticleHtml() ──
  // and as the admin panel's form. Summary (lead) is already in the header:
  //   2. Key Points   3. Multidimensional Analysis (= fullContent, the body)
  //   4. Major Issues 5. Government Initiatives    6. Bihar Specific
  //   7. Value Addition (= examRelevance)          8. Way Forward   9. Quotes
  if (data.keyPointsHtml)       renderSectionBlock(doc, data.keyPointsHtml,       'keyPoints',       ctx);
  renderNodes(doc, dom.children as any[], ctx);
  if (data.majorIssuesHtml)     renderSectionBlock(doc, data.majorIssuesHtml,     'majorIssues',     ctx);
  if (data.govtInitiativesHtml) renderSectionBlock(doc, data.govtInitiativesHtml, 'govtInitiatives', ctx);
  if (data.biharSpecificHtml)   renderSectionBlock(doc, data.biharSpecificHtml,   'biharSpecific',   ctx);
  if (data.examRelevanceHtml)   renderSectionBlock(doc, data.examRelevanceHtml,   'examRelevance',   ctx);
  if (data.wayForwardHtml)      renderSectionBlock(doc, data.wayForwardHtml,      'wayForward',      ctx);
  if (data.quotesHtml)          renderSectionBlock(doc, data.quotesHtml,          'quotes',          ctx);
  // Legacy — no longer authored in the admin panel, but old articles still have it.
  if (data.importantFactsHtml)  renderSectionBlock(doc, data.importantFactsHtml,  'importantFacts',  ctx);

  drawTagsFooter(doc, data, cw);

  // Post-process: watermark + logo header + page numbers on every buffered page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawWatermark(doc, logo);
    drawPageHeader(doc, logo, 'BPSCNotes');
    drawFooter(doc, i - range.start + 1, range.count);
  }

  doc.end();
}