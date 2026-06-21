/**
 * docx-text — extracts plain text from a .docx (Word) invoice in the Electron main process.
 *
 * A .docx is a ZIP whose `word/document.xml` holds the body as OOXML. We read just that
 * one entry (via the ZIP central directory + zlib inflate — no external dependency) and
 * flatten the XML to text: paragraphs become newlines, tabs/breaks become spaces, all
 * other tags are stripped. The resulting line-based text feeds the same parseInvoiceFields
 * heuristics used for PDFs.
 *
 * Never throws — any malformed/unknown structure resolves to '' so the save flow continues
 * and the invoice falls back to manual entry in the review card.
 */

import { inflateRawSync } from 'zlib';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50;  // Central directory file header
const LOC_SIG = 0x04034b50;  // Local file header
const TARGET = 'word/document.xml';

export async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const xml = readZipEntry(buffer, TARGET);
    if (!xml) return '';
    return xmlBodyToText(xml);
  } catch {
    return '';
  }
}

/** Reads and decompresses a single named entry from a ZIP buffer, or null if not found. */
function readZipEntry(buf: Buffer, name: string): string | null {
  // Locate the End Of Central Directory record by scanning backwards (it sits near the
  // end, after an optional comment of up to 64 KB).
  const minEnd = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEnd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset of first central-directory record

  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commLen  = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf-8', p + 46, p + 46 + nameLen);

    if (entryName === name) {
      // Jump to the local header to find where the actual data begins (its own
      // name/extra lengths can differ from the central record's).
      if (buf.readUInt32LE(localOff) !== LOC_SIG) return null;
      const lNameLen  = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      const raw = method === 0 ? data : inflateRawSync(data); // 0 = stored, 8 = deflate
      return raw.toString('utf-8');
    }
    p += 46 + nameLen + extraLen + commLen;
  }
  return null;
}

/** Flattens OOXML body XML to line-based plain text. */
function xmlBodyToText(xml: string): string {
  return xml
    .replace(/<w:p\b[^>]*\/>/g, '\n')          // empty paragraph
    .replace(/<\/w:p>/g, '\n')                  // paragraph end → newline
    .replace(/<w:(?:tab|br|cr)\b[^>]*\/?>/g, ' ') // tab / line break → space
    .replace(/<[^>]+>/g, '')                    // strip all remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .split(/\r?\n/)
    .map(l => l.replace(/\s{2,}/g, ' ').trim())
    .filter(l => l.length > 0)
    .join('\n');
}
