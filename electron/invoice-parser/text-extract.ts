/**
 * text-extract — dispatches an invoice attachment to the right text extractor based on
 * its content (magic bytes) and filename. Returns '' for unsupported/scanned files so the
 * caller falls back to manual entry. Runs only in the Electron main process.
 */

import { extractPdfText } from './pdf-text';
import { extractDocxText } from './docx-text';

export async function extractInvoiceText(buffer: Buffer, filename = ''): Promise<string> {
  if (!buffer || buffer.length < 4) return '';

  // %PDF magic → PDF (most invoices).
  if (buffer.subarray(0, 8).toString('latin1').includes('%PDF-')) {
    return extractPdfText(buffer);
  }

  // PK zip magic + .docx name → Word document. (Both .docx and legacy .doc may carry a
  // PK header in odd cases, but only OOXML .docx has word/document.xml; extractDocxText
  // safely returns '' otherwise.)
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
  if (isZip && filename.toLowerCase().endsWith('.docx')) {
    return extractDocxText(buffer);
  }

  return '';
}
