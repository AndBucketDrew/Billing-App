/**
 * Minimal TNEF (winmail.dat) extractor.
 *
 * Transport Neutral Encapsulation Format is a Microsoft-proprietary wrapper
 * that Outlook uses when sending Rich Text Format emails. The actual file
 * attachments (PDFs, images, etc.) are embedded inside a single winmail.dat
 * blob rather than being exposed as normal MIME parts.
 *
 * Format layout:
 *   4 bytes  signature  (0x223E9F78 LE)
 *   2 bytes  legacy key (ignored)
 *   then: repeated TNEF attributes, each:
 *     1 byte  level      (0x01 = message, 0x02 = attachment)
 *     2 bytes type       (attribute type/ID, LE)
 *     4 bytes size       (data length, LE)
 *     N bytes data
 *     2 bytes checksum   (sum of data bytes % 65536)
 *     P bytes padding    (align stream position to 4-byte boundary after checksum)
 *
 * Attribute types used here:
 *   0x8018  ATTACHTITLE          — display filename (null-terminated)
 *   0x9018  ATTACHTRANSPORTNAME  — transport filename (fallback, same format)
 *   0x800B  ATTACHDATA           — attachment binary content
 */

import { decompressRTF } from '@kenjiuno/decompressrtf';

const TNEF_SIGNATURE        = 0x223E9F78;
const LVL_ATTACHMENT        = 0x02;
const ATTR_ATTACH_TITLE     = 0x8018; // display name
const ATTR_ATTACH_TRANS     = 0x9018; // transport name (used by some Outlook versions)
const ATTR_ATTACH_DATA      = 0x800B; // binary file content
const ATTR_MAPI_PROPS       = 0x0069; // MAPI property stream (contains PR_ATTACH_LONG_FILENAME)

export interface TnefFile {
  name: string;
  data: Buffer;
}

export function isTnef(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === TNEF_SIGNATURE;
}

/**
 * Extracts all file attachments from a TNEF (winmail.dat) buffer.
 * Returns an empty array if the buffer is not valid TNEF or no files found.
 */
/** Scans a MAPI property chunk for PR_ATTACH_LONG_FILENAME (unicode then ascii). */
function readLongFilenameFromChunk(chunk: Buffer): string {
  const tags = [
    [Buffer.from([0x1F, 0x00, 0x07, 0x37]), 'utf16le' as const], // PT_UNICODE
    [Buffer.from([0x1E, 0x00, 0x07, 0x37]), 'latin1'  as const], // PT_STRING8
  ] as const;
  for (const [tag, enc] of tags) {
    const idx = chunk.lastIndexOf(tag as Buffer);
    if (idx < 0) continue;
    let p = idx + 4;
    if (p + 8 > chunk.length) continue;
    const fc = chunk.readUInt32LE(p); p += 4;
    if (fc > 1) continue;
    const fcb = chunk.readUInt32LE(p); p += 4;
    if (fcb > 0 && fcb < 1024 && p + fcb <= chunk.length) {
      const name = chunk.subarray(p, p + fcb).toString(enc).replace(/\0+$/, '').trim();
      if (name) return name;
    }
  }
  return '';
}

export function extractTnef(buf: Buffer): TnefFile[] {
  if (!isTnef(buf)) return [];

  let pos = 6; // 4-byte signature + 2-byte legacy key
  const files: TnefFile[] = [];
  let pendingName = '';
  let pendingData: Buffer | null = null;

  function flush(): void {
    if (pendingName && pendingData) {
      files.push({ name: pendingName, data: pendingData });
      pendingName = '';
      pendingData = null;
    }
  }

  while (pos + 7 <= buf.length) {
    const level = buf[pos];
    const type  = buf.readUInt16LE(pos + 1);
    const size  = buf.readUInt32LE(pos + 3);
    pos += 7; // consume header (1 + 2 + 4)

    if (pos + size > buf.length) break;
    const chunk = buf.subarray(pos, pos + size);
    pos += size;
    pos += 2; // checksum word

    // Align the stream to a 4-byte boundary AFTER the checksum.
    // This matches real Outlook output and reference parsers (libytnef, npm tnef).
    if (pos % 4 !== 0) pos += 4 - (pos % 4);

    if (level === LVL_ATTACHMENT) {
      if (type === ATTR_ATTACH_TITLE || type === ATTR_ATTACH_TRANS) {
        flush(); // save previous complete attachment
        pendingName = chunk.toString('latin1').replace(/\0+$/, '').trim();
        flush(); // also flush immediately if DATA arrived before TITLE
      } else if (type === ATTR_ATTACH_DATA) {
        pendingData = Buffer.from(chunk);
        flush();
      } else if (type === ATTR_MAPI_PROPS) {
        // ATTACHTITLE often holds the 8.3 short name; the MAPI property block
        // carries PR_ATTACH_LONG_FILENAME with the full name. Prefer it.
        const longName = readLongFilenameFromChunk(chunk);
        if (longName) {
          if (pendingData !== null) {
            // DATA not yet flushed — update before flush fires
            pendingName = longName;
          } else if (files.length > 0) {
            // DATA was already flushed — retroactively fix the saved entry
            files[files.length - 1].name = longName;
          }
        }
      }
    }
  }

  flush(); // catch any trailing attachment
  return files;
}

/**
 * Extracts file attachments from a TNEF buffer that uses the newer
 * MAPI property encoding (Exchange/Outlook 2007+) rather than the classic
 * ATTACHTITLE/ATTACHDATA attribute format.
 *
 * Two-pass approach:
 *   Pass 1 — scan for PR_ATTACH_DATA_BIN (0x37010102) property tags.
 *   Pass 2 — search for known file magic bytes (PDF, JPEG, PNG) as a fallback
 *             for TNEF files whose property layout doesn't match pass 1.
 */
export function extractMapiAttachments(buf: Buffer): TnefFile[] {
  const results: TnefFile[] = [];

  // MAPI property tags — stored as uint32 LE: [type_lo, type_hi, propid_lo, propid_hi]
  const DATA_TAG  = Buffer.from([0x02, 0x01, 0x01, 0x37]); // PT_BINARY + PR_ATTACH_DATA_BIN  (0x37010102)
  const FNAME_W   = Buffer.from([0x1F, 0x00, 0x07, 0x37]); // PT_UNICODE + PR_ATTACH_LONG_FILENAME
  const FNAME_A   = Buffer.from([0x1E, 0x00, 0x07, 0x37]); // PT_STRING8 + PR_ATTACH_LONG_FILENAME

  // Helper: read PR_ATTACH_LONG_FILENAME near a data tag position.
  // Searches the full prefix (nearest preceding match) then the full suffix
  // (nearest following match) because MAPI property ordering is not guaranteed.
  function readFilename(tagPos: number): string {
    for (const [tag, enc] of [[FNAME_W, 'utf16le'], [FNAME_A, 'latin1']] as const) {
      for (const idx of [
        buf.lastIndexOf(tag, tagPos - 1),              // nearest preceding
        buf.indexOf(tag, tagPos + DATA_TAG.length),    // nearest following
      ]) {
        if (idx < 0) continue;
        let fp = idx + 4;
        if (fp + 8 > buf.length) continue;
        const fc = buf.readUInt32LE(fp); fp += 4;
        if (fc > 1) continue;
        const fcb = buf.readUInt32LE(fp); fp += 4;
        if (fcb > 0 && fcb < 1024 && fp + fcb <= buf.length) {
          const name = buf.subarray(fp, fp + fcb).toString(enc as BufferEncoding).replace(/\0+$/, '').trim();
          if (name) return name;
        }
      }
    }
    return '';
  }

  // ── Pass 1: property tag scan ────────────────────────────────────────────────
  let searchPos = 0;
  while (searchPos < buf.length) {
    const tagPos = buf.indexOf(DATA_TAG, searchPos);
    if (tagPos < 0) break;

    let p = tagPos + 4;
    if (p + 8 > buf.length) { searchPos = tagPos + 1; continue; }

    // count field: accept 0 or 1
    const count = buf.readUInt32LE(p); p += 4;
    if (count > 1) { searchPos = tagPos + 1; continue; }

    const cb = buf.readUInt32LE(p); p += 4;
    if (cb < 16 || cb > 30 * 1024 * 1024 || p + cb > buf.length) {
      searchPos = tagPos + 1;
      continue;
    }

    const data = Buffer.from(buf.subarray(p, p + cb));
    const name = readFilename(tagPos) || 'attachment';
    results.push({ name, data });
    searchPos = p + cb;
  }

  if (results.length > 0) return results;

  // ── Pass 2: file magic scan (fallback for unusual MAPI layouts) ──────────────
  const MAGICS: Array<{ bytes: number[]; ext: string; name: string }> = [
    { bytes: [0x25, 0x50, 0x44, 0x46, 0x2D], ext: '.pdf', name: 'invoice.pdf' }, // %PDF-
    { bytes: [0xFF, 0xD8, 0xFF],              ext: '.jpg', name: 'image.jpg'   }, // JPEG
    { bytes: [0x89, 0x50, 0x4E, 0x47],        ext: '.png', name: 'image.png'   }, // PNG
  ];

  for (const { bytes, name: fallbackName } of MAGICS) {
    const magic = Buffer.from(bytes);
    const magicPos = buf.indexOf(magic);
    if (magicPos < 12) continue;

    // The MAPI binary property layout is: tag(4)+count(4)+cb(4)+data
    // so data starts 12 bytes after the tag; check if the cb field makes sense
    const cb = buf.readUInt32LE(magicPos - 4); // cb field sits 4 bytes before data
    if (cb < 16 || cb > buf.length - magicPos) continue; // must fit in remaining buffer

    const data = Buffer.from(buf.subarray(magicPos, magicPos + cb));
    // Try to find filename in the 2 KB before the data tag
    const tagPos = magicPos - 12;
    const name = readFilename(tagPos) || fallbackName;
    results.push({ name, data });
    break; // one file per magic scan pass is enough
  }

  return results;
}

/**
 * Extracts the RTF email body from a TNEF buffer that contains no file
 * attachments (e.g. a forwarded email whose invoice is in the body text).
 *
 * Outlook stores the body as a PR_RTF_COMPRESSED (LZFu) blob inside the
 * MAPI property stream.  We locate it by searching for the LZFu magic bytes
 * rather than fully parsing the MAPI property tree.
 *
 * Returns the decompressed RTF as a Buffer, or null if not found.
 * Save the result as a .rtf file — Word / WordPad can open it.
 */
export function extractRtfBody(buf: Buffer): Buffer | null {
  // LZFu magic: 'LZFu' = 4C 5A 46 75
  // MELA magic: 'MELA' = 4D 45 4C 41 (uncompressed RTF, rare)
  const LZFU = Buffer.from([0x4C, 0x5A, 0x46, 0x75]);
  const MELA = Buffer.from([0x4D, 0x45, 0x4C, 0x41]);

  let magicPos = buf.indexOf(LZFU);
  const isMela = magicPos < 8;
  if (isMela) magicPos = buf.indexOf(MELA);
  if (magicPos < 8) return null;

  // LZFu header layout (from [MS-OXRTFEX] 2.1.1.1):
  //   cbRawSize (4 bytes)  — uncompressed size
  //   cbSize    (4 bytes)  — compressed data size
  //   magic     (4 bytes)  ← magicPos
  //   CRC32     (4 bytes)
  //   data      (cbSize bytes)
  const headerStart = magicPos - 8;
  const cbRawSize = buf.readUInt32LE(headerStart);
  if (cbRawSize === 0 || cbRawSize > 4 * 1024 * 1024) return null;

  if (isMela) {
    // Uncompressed: body follows directly after the 16-byte header
    return buf.subarray(magicPos + 8, magicPos + 8 + cbRawSize);
  }

  // Read cbSize (compressed data length) and pass only the LZFu header + data
  // to the decompressor; copying the entire buffer as a number[] would use ~8×
  // the attachment size in heap.
  const cbSize = buf.readUInt32LE(headerStart + 4);
  // Clamp to the actual buffer end — some TNEF files over-report cbSize (e.g. when
  // the LZFu blob is embedded inside a larger MAPI property block whose own size
  // field is misread as cbSize).  The LZFu decompressor stops at cbRawSize bytes
  // decompressed regardless of how many compressed bytes are supplied.
  const dataEnd = Math.min(headerStart + 16 + cbSize, buf.length);
  const blob = Array.from(buf.subarray(headerStart, dataEnd));
  try {
    const result = decompressRTF(blob);
    return result.length > 0 ? Buffer.from(result) : null;
  } catch {
    return null;
  }
}
