/**
 * pdf-text — extracts a plain-text layer from a PDF buffer (Electron main process).
 *
 * Uses `pdf-parse` v1, whose bundled pdfjs (2.x) extracts text in a plain Node runtime
 * with no canvas globals. (The v2 rewrite needs DOMMatrix/Path2D and Node 22's
 * process.getBuiltinModule, neither of which Electron 29's main process provides.)
 * Runs only in the Node main process — the dependency never reaches the Angular bundle.
 *
 * Scope: TEXT-LAYER PDFs only. Scanned/image-only PDFs have no extractable text and
 * return '' — callers treat an empty result as "needs manual entry" rather than an
 * error, so the invoice still surfaces in the review queue for the user to fill in.
 */

// Import the library entry directly. pdf-parse's index.js has a "debug mode" branch that
// reads a bundled sample PDF when required without a parent module — importing the lib file
// skips that wrapper and the ENOENT it can throw under a packaged build.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse: (data: Buffer) => Promise<{ text: string }> = require('pdf-parse/lib/pdf-parse.js');

/**
 * Extracts text from a PDF buffer. Never throws — a parse failure (corrupt file,
 * non-PDF, image-only) resolves to '' so the save flow is never interrupted.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  if (!isPdf(buffer)) return '';
  try {
    const result = await pdfParse(buffer);
    return (result.text ?? '').trim();
  } catch {
    // Encrypted, malformed, or image-only PDF — fall back to manual entry.
    return '';
  }
}

/** A PDF always begins with the "%PDF-" magic header (optionally after a BOM). */
function isPdf(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 5) return false;
  // Scan the first few bytes — some files prepend a UTF-8 BOM before "%PDF".
  const head = buffer.subarray(0, 8).toString('latin1');
  return head.includes('%PDF-');
}
