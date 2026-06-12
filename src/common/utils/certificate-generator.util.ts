// ════════════════════════════════════════════════════════════
// CERTIFICATE GENERATOR — generates a "Certificate of Completion"
// PDF for a user+course, saves it to local disk under
// uploads/certificates/, and returns the public URL.
//
// Uses PDFKit (pure JS, no native deps / no headless browser).
// Install: npm install pdfkit @types/pdfkit --save
// ════════════════════════════════════════════════════════════
import * as fs from 'fs';
import { join } from 'path';
// require() avoids a hard dependency on @types/pdfkit being installed —
// pdfkit itself ships no types, so `import * as` fails type-checking
// unless @types/pdfkit is present. require() + `as any` sidesteps this.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

export interface CertificateData {
  userName: string;
  courseTitle: string;
  instructor?: string | null;
  completedAt: string | Date;
  certificateId: string; // certificates.id — used in the filename + footer
}

/**
 * Renders a single-page landscape "Certificate of Completion" PDF
 * and writes it to <UPLOAD_DIR>/certificates/<certificateId>.pdf
 *
 * Returns the path relative to UPLOAD_DIR (e.g. "certificates/<id>.pdf"),
 * suitable for building the public URL as `${BASE_URL}/uploads/${relativePath}`.
 */
export async function generateCertificatePdf(
  uploadDir: string,
  data: CertificateData,
): Promise<string> {
  const dest = join(uploadDir, 'certificates');
  fs.mkdirSync(dest, { recursive: true });

  const fileName = `${data.certificateId}.pdf`;
  const fullPath = join(dest, fileName);
  const relativePath = `certificates/${fileName}`;

  // Landscape A4: 841.89 x 595.28 pt
  const doc = new PDFDocument({
    layout: 'landscape',
    size: 'A4',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  const stream = fs.createWriteStream(fullPath);
  doc.pipe(stream);

  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const BRAND = '#1565C0';
  const GOLD = '#F5B400';
  const INK = '#1E293B';
  const MUTED = '#64748B';

  // ── Outer border ──────────────────────────────────────────
  doc.save();
  doc.lineWidth(3).strokeColor(BRAND)
    .rect(24, 24, PAGE_W - 48, PAGE_H - 48).stroke();
  doc.lineWidth(1).strokeColor(GOLD)
    .rect(34, 34, PAGE_W - 68, PAGE_H - 68).stroke();
  doc.restore();

  // ── Header ────────────────────────────────────────────────
  doc.fillColor(BRAND)
    .font('Helvetica-Bold')
    .fontSize(28)
    .text('BPSCNotes', 0, 60, { align: 'center', width: PAGE_W });

  doc.fillColor(GOLD)
    .font('Helvetica-Bold')
    .fontSize(40)
    .text('CERTIFICATE OF COMPLETION', 0, 110, { align: 'center', width: PAGE_W });

  doc.moveTo(PAGE_W / 2 - 120, 165)
    .lineTo(PAGE_W / 2 + 120, 165)
    .lineWidth(1.5)
    .strokeColor(GOLD)
    .stroke();

  // ── Body ──────────────────────────────────────────────────
  doc.fillColor(MUTED)
    .font('Helvetica')
    .fontSize(14)
    .text('This certificate is proudly presented to', 0, 195, {
      align: 'center',
      width: PAGE_W,
    });

  doc.fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(34)
    .text(data.userName, 0, 222, { align: 'center', width: PAGE_W });

  doc.fillColor(MUTED)
    .font('Helvetica')
    .fontSize(14)
    .text('for successfully completing the course', 0, 272, {
      align: 'center',
      width: PAGE_W,
    });

  doc.fillColor(BRAND)
    .font('Helvetica-Bold')
    .fontSize(24)
    .text(`"${data.courseTitle}"`, 60, 300, {
      align: 'center',
      width: PAGE_W - 120,
    });

  const completedDate = new Date(data.completedAt);
  const dateStr = isNaN(completedDate.getTime())
    ? new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : completedDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  doc.fillColor(MUTED)
    .font('Helvetica')
    .fontSize(13)
    .text(`Completed on ${dateStr}`, 0, 350, { align: 'center', width: PAGE_W });

  // ── Footer: signature + certificate ID ──────────────────────
  const footerY = PAGE_H - 110;

  doc.fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(data.instructor || 'BPSCNotes Team', 100, footerY, { width: 220, align: 'center' });
  doc.moveTo(100, footerY - 6).lineTo(320, footerY - 6).lineWidth(1).strokeColor('#CBD5E1').stroke();
  doc.fillColor(MUTED).font('Helvetica').fontSize(10)
    .text('Instructor', 100, footerY + 18, { width: 220, align: 'center' });

  doc.fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text('BPSCNotes', PAGE_W - 320, footerY, { width: 220, align: 'center' });
  doc.moveTo(PAGE_W - 320, footerY - 6).lineTo(PAGE_W - 100, footerY - 6).lineWidth(1).strokeColor('#CBD5E1').stroke();
  doc.fillColor(MUTED).font('Helvetica').fontSize(10)
    .text('Issued by', PAGE_W - 320, footerY + 18, { width: 220, align: 'center' });

  doc.fillColor('#CBD5E1')
    .font('Helvetica')
    .fontSize(8)
    .text(`Certificate ID: ${data.certificateId}`, 0, PAGE_H - 36, {
      align: 'center',
      width: PAGE_W,
    });

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });

  return relativePath;
}