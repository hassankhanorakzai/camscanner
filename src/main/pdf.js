'use strict';
/**
 * PDF generation. Every page keeps the aspect ratio of its own image — pages
 * are never forced into A4. The physical size is derived either from a DPI
 * value or from a real-world reference size (ID card / passport).
 */
const { PDFDocument } = require('pdf-lib');

const MM = 72 / 25.4;
// Long side of well-known documents, in points. The short side always follows the real image ratio.
const REFERENCE_LONG_SIDE = {
  id1: 85.6 * MM, // ISO/IEC 7810 ID-1 (CNIC, driving licence, bank card)
  id2: 105 * MM, // ID-2
  passport: 125 * MM, // ID-3 passport page
};

const COMPRESSION = {
  original: null,
  high: { maxDim: 3000, quality: 88 },
  balanced: { maxDim: 2200, quality: 76 },
  small: { maxDim: 1500, quality: 62 },
};

function pageSize(width, height, { mode = 'dpi', dpi = 200 } = {}) {
  if (REFERENCE_LONG_SIDE[mode]) {
    const long = REFERENCE_LONG_SIDE[mode];
    return width >= height ? [long, (long * height) / width] : [(long * width) / height, long];
  }
  const d = Math.min(1200, Math.max(36, Number(dpi) || 200));
  let w = (width / d) * 72; let h = (height / d) * 72;
  const max = 14400; // PDF user-unit limit
  if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w *= s; h *= s; }
  return [w, h];
}

/**
 * pages: [{ bytes: Buffer, width, height }] in final order.
 * imaging: module with imageInfo/reencode/toJpeg (injected for testability).
 */
async function buildPdf(pages, options = {}, imaging) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(options.title || 'SmartScan document');
  pdf.setCreator('SmartScan');
  pdf.setProducer('SmartScan (pdf-lib)');
  pdf.setCreationDate(new Date());
  pdf.setModificationDate(new Date());
  if (options.subject) pdf.setSubject(options.subject);
  const comp = COMPRESSION[options.compression] || null;

  for (const page of pages) {
    let bytes = page.bytes;
    let info = imaging.imageInfo(bytes);
    if (!info) throw new Error('Page image is not a valid JPEG or PNG');
    // Re-encode when compressing, or when EXIF rotation would otherwise be ignored by PDF viewers.
    if (comp || (info.type === 'jpeg' && info.orientation && info.orientation !== 1)) {
      bytes = imaging.reencode(bytes, comp || { quality: 92 });
      info = imaging.imageInfo(bytes);
    }
    const img = info.type === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const [w, h] = pageSize(page.width || info.width, page.height || info.height, options);
    const p = pdf.addPage([w, h]);
    p.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

module.exports = { buildPdf, pageSize, COMPRESSION, REFERENCE_LONG_SIDE };
