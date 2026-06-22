// ════════════════════════════════════════════════════════════
// CURRENT AFFAIRS — ARTICLE PDF GENERATOR
//
// Renders the same sanitized rich-content HTML the admin panel and
// Android WebView display into a watermarked PDF. Deliberately built
// on PDFKit (already a dependency — see certificate-generator.util.ts)
// rather than a headless-browser approach (Puppeteer/Playwright):
// this backend runs Node 20 on Alpine on a modest VPS, and pulling in
// Chromium there means a much larger Docker image, `--no-sandbox` /
// shared-memory workarounds, and real per-request memory/CPU pressure
// for something that doesn't need full CSS/browser fidelity — the
// admin editor's output is a small, known set of tags (see
// CA_SANITIZE_OPTIONS in combined-modules-1.module.ts), which a
// hand-rolled walker can render perfectly well without a browser.
//
// Install: npm install htmlparser2 --save
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
  category: string;
  date: string;
  source?: string | null;
  tags?: string[];
  fullContentHtml: string; // already sanitized server-side
}

// ── Look & feel ─────────────────────────────────────────────
const INK         = '#1E293B';
const MUTED       = '#64748B';
const BRAND       = '#1565C0';
const BRAND_LIGHT = '#E8F1FC';
const BORDER      = '#CBD5E1';
const PAGE_MARGIN = 50;

interface Style {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  color?: string; highlight?: string; link?: string;
}
interface Run { text: string; style: Style }
interface RenderCtx { contentX: number; contentWidth: number; imageMap: Map<string, Buffer> }

// ── Style helpers ────────────────────────────────────────────
function fontFor(style: Style): string {
  if (style.bold && style.italic) return 'Helvetica-BoldOblique';
  if (style.bold) return 'Helvetica-Bold';
  if (style.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}
function extractStyleColor(styleAttr?: string): string | undefined {
  if (!styleAttr) return undefined;
  const m = /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{3,6}|rgb\([^)]+\))/.exec(styleAttr);
  return m ? m[1] : undefined;
}
function extractBgColor(styleAttr?: string): string | undefined {
  if (!styleAttr) return undefined;
  const m = /background-color\s*:\s*(#[0-9a-fA-F]{3,6}|rgb\([^)]+\))/.exec(styleAttr);
  return m ? m[1] : undefined;
}
function extractWidthPct(styleAttr?: string): number | undefined {
  if (!styleAttr) return undefined;
  const m = /width\s*:\s*(\d+(?:\.\d+)?)%/.exec(styleAttr);
  return m ? parseFloat(m[1]) : undefined;
}
// Matches the exact margin shorthands RichTextEditor.tsx's AlignableImage
// extension produces: "10px auto" (center), "10px 0 10px auto" (right),
// "10px auto 10px 0" (left).
function extractAlign(styleAttr?: string): 'left' | 'center' | 'right' {
  if (!styleAttr) return 'left';
  const m = /margin\s*:\s*([^;]+);?/.exec(styleAttr);
  if (!m) return 'left';
  const t = m[1].trim().split(/\s+/);
  if (t.length === 2 && t[1] === 'auto') return 'center';
  if (t.length === 4) {
    if (t[3] === 'auto' && t[1] !== 'auto') return 'right';
    if (t[1] === 'auto' && t[3] !== 'auto') return 'left';
  }
  return 'left';
}
function collapseWs(text: string): string { return text.replace(/\s+/g, ' '); }
function safeFileName(title: string): string {
  return (title || 'article').replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().slice(0, 80) || 'article';
}

// ── HTML → styled run list ──────────────────────────────────
function flattenRuns(nodes: any[], style: Style, runs: Run[] = []): Run[] {
  for (const node of nodes || []) {
    if (node.type === 'text') {
      const text = collapseWs(node.data || '');
      if (text) runs.push({ text, style });
      continue;
    }
    if (node.type !== 'tag') continue;
    const attribs = node.attribs || {};
    switch (node.name) {
      case 'strong': case 'b':
        flattenRuns(node.children, { ...style, bold: true }, runs); break;
      case 'em': case 'i':
        flattenRuns(node.children, { ...style, italic: true }, runs); break;
      case 'u':
        flattenRuns(node.children, { ...style, underline: true }, runs); break;
      case 's':
        flattenRuns(node.children, { ...style, strike: true }, runs); break;
      case 'a':
        flattenRuns(node.children, { ...style, color: style.color || BRAND, underline: true, link: attribs.href }, runs);
        break;
      case 'span': case 'mark': {
        const color = extractStyleColor(attribs.style);
        const bg    = extractBgColor(attribs.style);
        flattenRuns(node.children, { ...style, color: color || style.color, highlight: bg || style.highlight }, runs);
        break;
      }
      case 'br':
        runs.push({ text: '\n', style });
        break;
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

// Emits a chain of mixed-style runs as one flowing paragraph via PDFKit's
// `continued` text mode, so bold/italic/underline/links/highlights can all
// sit inline within the same wrapped paragraph.
function emitParagraphRuns(doc: any, runs: Run[], fontSize: number, x: number, width: number) {
  if (!runs.length) return;
  doc.x = x;
  runs.forEach((run, i) => {
    const isLast = i === runs.length - 1;
    if (run.style.highlight && run.text.trim()) {
      // Approximation: only accurate for runs that don't wrap mid-highlight,
      // which covers the vast majority of real highlighted phrases.
      const w = doc.widthOfString(run.text, { font: fontFor(run.style), size: fontSize });
      doc.save().fillColor(run.style.highlight).fillOpacity(0.9)
        .rect(doc.x, doc.y + 1, w, fontSize * 1.2).fill();
      doc.restore();
    }
    doc.font(fontFor(run.style)).fontSize(fontSize).fillColor(run.style.color || INK);
    doc.text(run.text, {
      continued: !isLast,
      underline: !!run.style.underline,
      strike: !!run.style.strike,
      link: run.style.link || undefined,
      width,
    });
  });
}

function ensureSpace(doc: any, neededHeight: number) {
  const topOfContent = doc.page.margins.top;
  // If we're already near the top of a fresh page, adding another page
  // would immediately produce a blank one — skip in that case.
  if (doc.y < topOfContent + 120) return;
  if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function renderHeading(doc: any, el: any, ctx: RenderCtx, size: number) {
  const runs = trimRuns(flattenRuns(el.children, { bold: true }));
  if (!runs.length) return;
  ensureSpace(doc, size + 14);
  emitParagraphRuns(doc, runs, size, ctx.contentX, ctx.contentWidth);
  doc.moveDown(0.35);
}

function renderParagraph(doc: any, el: any, ctx: RenderCtx) {
  const runs = trimRuns(flattenRuns(el.children, {}));
  if (!runs.length) return; // skip empty <p> entirely — no moveDown accumulation
  emitParagraphRuns(doc, runs, 11, ctx.contentX, ctx.contentWidth);
  doc.moveDown(0.45);
}

function renderBlockquote(doc: any, el: any, ctx: RenderCtx) {
  const x = ctx.contentX + 16;
  const w = ctx.contentWidth - 16;
  const startY = doc.y;
  const blocks = (el.children || []).filter((c: any) => c.type === 'tag' && c.name === 'p');
  const paragraphs = blocks.length ? blocks : [{ children: el.children }];
  for (const p of paragraphs) {
    const runs = trimRuns(flattenRuns(p.children, { italic: true, color: MUTED }));
    if (!runs.length) continue;
    ensureSpace(doc, 30);
    emitParagraphRuns(doc, runs, 11, x, w);
    doc.moveDown(0.3);
  }
  const endY = doc.y;
  if (endY > startY) {
    // Cosmetic left border — not corrected for blockquotes that
    // straddle a page break, which is rare enough to be an acceptable gap.
    doc.save().fillColor(BRAND).rect(ctx.contentX, startY, 3, Math.max(0, endY - startY - 4)).fill().restore();
  }
  doc.moveDown(0.4);
  doc.x = ctx.contentX;
}

function renderList(doc: any, items: any[], ctx: RenderCtx, ordered: boolean, depth: number) {
  let idx = 1;
  for (const li of items || []) {
    if (li.type !== 'tag' || li.name !== 'li') continue;
    const indent = depth * 16;
    const x = ctx.contentX + indent;
    const w = ctx.contentWidth - indent;
    ensureSpace(doc, 20);
    const marker = ordered ? `${idx}.` : '•';
    idx++;
    const ownChildren = (li.children || []).filter((c: any) => !(c.type === 'tag' && (c.name === 'ul' || c.name === 'ol')));
    const runs = trimRuns(flattenRuns(ownChildren, {}));
    // Marker prefixed into the same run chain — wrapped continuation lines
    // land flush at the column edge rather than hanging-indented past the
    // marker; a deliberate simplification for short, typical bullet items.
    emitParagraphRuns(doc, [{ text: `${marker}  `, style: {} }, ...runs], 11, x, w);
    doc.moveDown(0.25);
    for (const sub of li.children || []) {
      if (sub.type === 'tag' && sub.name === 'ul') renderList(doc, sub.children, ctx, false, depth + 1);
      if (sub.type === 'tag' && sub.name === 'ol') renderList(doc, sub.children, ctx, true, depth + 1);
    }
  }
  doc.x = ctx.contentX;
}

function renderTable(doc: any, tableEl: any, ctx: RenderCtx) {
  const rows: { cells: any[]; isHeader: boolean }[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes || []) {
      if (n.type !== 'tag') continue;
      if (n.name === 'thead' || n.name === 'tbody') { walk(n.children); continue; }
      if (n.name === 'tr') {
        const cells = (n.children || []).filter((c: any) => c.type === 'tag' && (c.name === 'td' || c.name === 'th'));
        if (cells.length) rows.push({ cells, isHeader: cells.some((c: any) => c.name === 'th') });
      }
    }
  };
  walk(tableEl.children);
  if (!rows.length) return;

  const numCols = Math.max(...rows.map(r => r.cells.length));
  if (numCols === 0) return;
  const colWidth = ctx.contentWidth / numCols;
  const padX = 6, padY = 5;

  for (const row of rows) {
    // Table cells are flattened to plain text — mixed bold/italic/links
    // *within* a single cell aren't preserved, a deliberate trade-off to
    // keep the grid-layout math (column widths, row-height measurement,
    // page-break checks) tractable.
    const cellTexts = row.cells.map((c: any) => trimRuns(flattenRuns(c.children, {})).map(r => r.text).join(''));
    let rowHeight = 0;
    cellTexts.forEach((text) => {
      const h = doc.heightOfString(text || ' ', { width: colWidth - padX * 2, font: row.isHeader ? 'Helvetica-Bold' : 'Helvetica', size: 9 });
      rowHeight = Math.max(rowHeight, h);
    });
    rowHeight += padY * 2;
    ensureSpace(doc, rowHeight);

    const rowY = doc.y;
    if (row.isHeader) {
      doc.save().fillColor(BRAND_LIGHT).rect(ctx.contentX, rowY, ctx.contentWidth, rowHeight).fill().restore();
    }
    row.cells.forEach((_cell: any, i: number) => {
      const cx = ctx.contentX + i * colWidth;
      doc.save().strokeColor(BORDER).lineWidth(0.5).rect(cx, rowY, colWidth, rowHeight).stroke().restore();
      doc.font(row.isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK)
        .text(cellTexts[i] || '', cx + padX, rowY + padY, { width: colWidth - padX * 2, height: rowHeight - padY * 2 });
    });

    doc.y = rowY + rowHeight;
    doc.x = ctx.contentX;
  }
  doc.moveDown(0.6);
}

function renderImage(doc: any, el: any, ctx: RenderCtx) {
  const src = el.attribs?.src;
  const buf = src ? ctx.imageMap.get(src) : undefined;
  if (!buf) return;
  let img: any;
  try { img = doc.openImage(buf); } catch { return; }

  const widthPct = extractWidthPct(el.attribs?.style) ?? 100;
  const align = extractAlign(el.attribs?.style);
  const targetW = Math.min(ctx.contentWidth, ctx.contentWidth * (widthPct / 100));
  const targetH = img.height * (targetW / img.width);

  ensureSpace(doc, targetH);
  let x = ctx.contentX;
  if (align === 'center') x = ctx.contentX + (ctx.contentWidth - targetW) / 2;
  else if (align === 'right') x = ctx.contentX + (ctx.contentWidth - targetW);

  doc.image(img, x, doc.y, { width: targetW, height: targetH });
  doc.y += targetH + 10;
  doc.x = ctx.contentX;
}

function renderNodes(doc: any, nodes: any[], ctx: RenderCtx) {
  for (const node of nodes || []) {
    if (node.type !== 'tag') continue;
    switch (node.name) {
      case 'h1': renderHeading(doc, node, ctx, 17); break;
      case 'h2': renderHeading(doc, node, ctx, 14.5); break;
      case 'h3': renderHeading(doc, node, ctx, 12.5); break;
      case 'p': renderParagraph(doc, node, ctx); break;
      case 'blockquote': renderBlockquote(doc, node, ctx); break;
      case 'ul': renderList(doc, node.children, ctx, false, 0); break;
      case 'ol': renderList(doc, node.children, ctx, true, 0); break;
      case 'table': renderTable(doc, node, ctx); break;
      case 'img': renderImage(doc, node, ctx); break;
      default: renderNodes(doc, node.children, ctx);
    }
  }
}

// ── Images: collected and pre-fetched once before the synchronous
// PDFKit drawing pass starts (PDFKit's drawing calls aren't safe to
// interleave with async work) ───────────────────────────────────
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
      if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function loadImageBuffer(src: string, uploadDir: string): Promise<Buffer | null> {
  // Article images are always our own /uploads/current-affairs/... files
  // (the editor only ever inserts via the upload-image endpoint) — read
  // straight off disk rather than round-tripping through HTTP to ourselves.
  // The network fetch is just a defensive fallback.
  try {
    const idx = src.indexOf('/uploads/');
    if (idx !== -1) {
      const relative = src.substring(idx + '/uploads/'.length);
      const localPath = join(uploadDir, relative);
      if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
    }
  } catch (_) { /* fall through to network fetch */ }
  return fetchBuffer(src).catch(() => null);
}

// ── Page chrome — drawn in a post-process pass over every already-
// rendered page (bufferPages: true), not interleaved with content
// drawing, which keeps PDFKit's internal text-flow state safe ───
function drawWatermark(doc: any, logoBuffer?: Buffer) {
  const { width, height } = doc.page;
  doc.save();

  if (logoBuffer) {
    // Single centered logo image — matches study materials watermark style.
    // Drawn at ~35% of page width, centered both axes, low opacity so it
    // sits behind content without obscuring it.
    try {
      const img = doc.openImage(logoBuffer);
      const maxW = width * 0.35;
      const maxH = height * 0.35;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const iw = img.width * scale;
      const ih = img.height * scale;
      const ix = (width - iw) / 2;
      const iy = (height - ih) / 2;
      doc.fillOpacity(0.07).image(img, ix, iy, { width: iw, height: ih });
    } catch (_) {
      // Image failed to open (corrupt / unsupported format) — fall through
      // to the text fallback below rather than crashing the whole PDF.
      doc.fillColor(BRAND).fillOpacity(0.07);
      doc.font('Helvetica-Bold').fontSize(28)
        .text('BPSCNotes', 0, height / 2 - 20, { width, align: 'center' });
    }
  } else {
    // No logo file available — single centered text instead of the old
    // tiled diagonal repeat (which looked cluttered).
    doc.fillColor(BRAND).fillOpacity(0.07);
    doc.font('Helvetica-Bold').fontSize(28)
      .text('BPSCNotes', 0, height / 2 - 20, { width, align: 'center' });
    doc.fontSize(11)
      .text('www.bpscnotes.in', 0, height / 2 + 18, { width, align: 'center' });
  }

  doc.restore();
}
function drawFooter(doc: any, pageNum: number, totalPages: number) {
  const { width, height, margins } = doc.page;
  doc.save();
  doc.fillOpacity(1).fillColor(MUTED).font('Helvetica').fontSize(8);
  doc.text(`BPSC Notes  ·  Page ${pageNum} of ${totalPages}`, margins.left, height - margins.bottom + 16, {
    width: width - margins.left - margins.right,
    align: 'center',
  });
  doc.restore();
}
function drawHeader(doc: any, data: ArticlePdfData, contentWidth: number) {
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10)
    .text((data.category || '').toUpperCase(), PAGE_MARGIN, doc.y, { width: contentWidth });
  doc.moveDown(0.3);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20)
    .text(data.title, PAGE_MARGIN, doc.y, { width: contentWidth });
  doc.moveDown(0.3);
  let dateStr = data.date;
  try { dateStr = new Date(data.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (_) {}
  doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
    .text(`${dateStr}${data.source ? '   ·   Source: ' + data.source : ''}`, PAGE_MARGIN, doc.y, { width: contentWidth });
  doc.moveDown(0.6);
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + contentWidth, doc.y).strokeColor(BORDER).lineWidth(1).stroke();
  doc.moveDown(0.8);
  doc.x = PAGE_MARGIN;
}
function drawTagsFooter(doc: any, data: ArticlePdfData, contentWidth: number) {
  if (!data.tags?.length) return;
  doc.moveDown(0.6);
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + contentWidth, doc.y).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
  doc.fillColor(BRAND).font('Helvetica').fontSize(9)
    .text(data.tags.map(t => `#${t}`).join('   '), PAGE_MARGIN, doc.y, { width: contentWidth });
}

// ── Simple HTML tag stripper for plain-text fields (title, source)
// The admin panel now saves Headline as inline-rich HTML — PDFKit draws
// raw strings, so we must strip before passing to the header renderer.
function stripHtmlForPdf(html: string): string {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// Logo look-up order: uploaded file at predictable path (works in Docker
// since uploads/ is a mounted volume), then src/assets/ (dev), then none.
const LOGO_SEARCH_PATHS = [
  join(process.cwd(), 'uploads', 'logo.png'),
  join(process.cwd(), 'uploads', 'logo.jpg'),
  join(process.cwd(), 'src', 'assets', 'logo.png'),
  join(process.cwd(), 'src', 'assets', 'logo.jpg'),
];
let _logoBuf: Buffer | null | undefined; // undefined = not yet checked
function loadLogoCached(): Buffer | null {
  if (_logoBuf !== undefined) return _logoBuf;
  for (const p of LOGO_SEARCH_PATHS) {
    try { if (fs.existsSync(p)) { _logoBuf = fs.readFileSync(p); return _logoBuf; } }
    catch (_) {}
  }
  _logoBuf = null;
  return null;
}

/**
 * Streams a watermarked PDF of a Current Affairs article directly to the
 * HTTP response. Generated fresh on every call (no disk caching) — typical
 * article length + locally-stored images keeps this fast enough that
 * caching isn't worth the staleness/invalidation complexity.
 */
export async function streamArticlePdf(res: Response, data: ArticlePdfData, uploadDir: string): Promise<void> {
  // Strip HTML from title — the admin panel saves it as inline-rich HTML
  // (TipTap inline marks), but PDFKit renders raw strings, not HTML.
  const plainTitle = stripHtmlForPdf(data.title);

  // Collapse consecutive empty <p></p> blocks — TipTap's default empty
  // state adds trailing empty paragraphs that manifested as blank PDF pages.
  const cleanedHtml = (data.fullContentHtml || '')
    .replace(/(<p>\s*<\/p>\s*){2,}/gi, '<p></p>') // deduplicate runs of empties
    .replace(/(<p>\s*<\/p>\s*)+$/gi, '');           // strip trailing empties entirely

  const dom = parseDocument(cleanedHtml);
  const imageSrcs = collectImageSrcs(dom.children);
  const imageMap = new Map<string, Buffer>();
  await Promise.all(imageSrcs.map(async (src) => {
    const buf = await loadImageBuffer(src, uploadDir);
    if (buf) imageMap.set(src, buf);
  }));

  const logoBuffer = loadLogoCached() ?? undefined;

  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const contentWidth = doc.page.width - PAGE_MARGIN * 2;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(plainTitle)}.pdf"`);
  doc.pipe(res);

  drawHeader(doc, { ...data, title: plainTitle }, contentWidth);
  renderNodes(doc, dom.children, { contentX: PAGE_MARGIN, contentWidth, imageMap });
  drawTagsFooter(doc, data, contentWidth);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawWatermark(doc, logoBuffer);
    drawFooter(doc, i - range.start + 1, range.count);
  }

  doc.end();
}