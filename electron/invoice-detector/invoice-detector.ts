/**
 * InvoiceDetector — pure heuristic engine, no network calls.
 *
 * Scoring rubric (max 100 pts):
 *   40  Filename contains an invoice keyword
 *   30  Subject contains an invoice keyword
 *   15  Attachment is a PDF (by MIME type or extension)
 *   10  Sender domain matches a known commercial pattern
 *    5  Email body preview mentions an invoice keyword
 *
 * Confidence thresholds:
 *   ≥ 70 → high   (auto-suggest, minimal confirmation)
 *   ≥ 35 → medium (require explicit user confirmation)
 *   < 35 → low    (silently ignored)
 *
 * You can extend FILENAME_KEYWORDS, SUBJECT_KEYWORDS, or COMMERCIAL_DOMAINS
 * at any time without touching the scoring logic.
 */

import type { GraphMessage, GraphAttachment } from '../graph/graph-client';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface DetectedInvoice {
  messageId: string;
  attachmentId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
  attachmentName: string;
  attachmentSize: number;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  reasons: string[];
  /** Relative sub-folder suggestion, e.g. "2024/04-April" */
  suggestedSubFolder: string;
}

// ─── Keyword lists ────────────────────────────────────────────────────────────

const FILENAME_KEYWORDS = [
  'invoice', 'rechnung', 'bill', 'faktura', 'factura', 'fattura',
  'quittung', 'receipt', 'zahlungsbeleg', 'gutschrift',
];

const SUBJECT_KEYWORDS = [
  'invoice', 'rechnung', 'bill', 'payment', 'zahlung', 'faktura',
  'your order', 'ihre bestellung', 'purchase', 'kauf', 'receipt',
  'order confirmation', 'bestellbestätigung',
];

/** Partial domain fragments — checked against sender email address */
const COMMERCIAL_DOMAINS = [
  'amazon', 'paypal', 'ebay', 'microsoft', 'google', 'apple',
  'booking.com', 'airbnb', 'stripe', 'paddle', 'fastspring',
];

const PDF_MIME = 'application/pdf';
const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.tiff'];
const ALLOWED_MIMES = [PDF_MIME, 'image/jpeg', 'image/png', 'image/tiff'];

// ─── Detector ─────────────────────────────────────────────────────────────────

export class InvoiceDetector {
  /**
   * Analyses a single email + its attachment list.
   * Returns one DetectedInvoice per qualifying attachment (low confidence excluded).
   */
  analyze(message: GraphMessage, attachments: GraphAttachment[]): DetectedInvoice[] {
    const results: DetectedInvoice[] = [];

    for (const att of attachments) {
      if (att.isInline) continue;
      if (!this.isProcessableFile(att)) continue;

      const { score, reasons } = this.score(message, att);
      const confidence = this.toConfidence(score);

      if (confidence === 'low') continue;

      results.push({
        messageId: message.id,
        attachmentId: att.id,
        senderName: message.from.emailAddress.name,
        senderEmail: message.from.emailAddress.address,
        subject: message.subject ?? '(no subject)',
        receivedAt: message.receivedDateTime,
        attachmentName: att.name,
        attachmentSize: att.size,
        confidence,
        confidenceScore: score,
        reasons,
        suggestedSubFolder: this.suggestSubFolder(message.receivedDateTime),
      });
    }

    return results;
  }

  // ─── Scoring ───────────────────────────────────────────────────────────────

  private score(
    message: GraphMessage,
    att: GraphAttachment,
  ): { score: number; reasons: string[] } {
    let total = 0;
    const reasons: string[] = [];

    // ── Filename keyword (0–40) ──────────────────────────────────────────────
    const lowerName = att.name.toLowerCase();
    const nameKw = FILENAME_KEYWORDS.find(kw => lowerName.includes(kw));
    if (nameKw) {
      total += 40;
      reasons.push(`Filename contains "${nameKw}"`);
    }

    // ── Subject keyword (0–30) ───────────────────────────────────────────────
    const lowerSubject = (message.subject ?? '').toLowerCase();
    const subjectKw = SUBJECT_KEYWORDS.find(kw => lowerSubject.includes(kw));
    if (subjectKw) {
      total += 30;
      reasons.push(`Subject contains "${subjectKw}"`);
    }

    // ── PDF attachment (0–15) ────────────────────────────────────────────────
    if (att.contentType === PDF_MIME || lowerName.endsWith('.pdf')) {
      total += 15;
      reasons.push('PDF attachment');
    }

    // ── Commercial sender domain (0–10) ─────────────────────────────────────
    const lowerEmail = message.from.emailAddress.address.toLowerCase();
    const domain = COMMERCIAL_DOMAINS.find(d => lowerEmail.includes(d));
    if (domain) {
      total += 10;
      reasons.push(`Known commercial sender (${domain})`);
    }

    // ── Body preview keyword (0–5) ───────────────────────────────────────────
    const lowerBody = (message.bodyPreview ?? '').toLowerCase();
    const bodyKw = SUBJECT_KEYWORDS.find(kw => lowerBody.includes(kw));
    if (bodyKw) {
      total += 5;
      reasons.push('Invoice keyword in email body');
    }

    return { score: Math.min(total, 100), reasons };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private toConfidence(score: number): ConfidenceLevel {
    if (score >= 70) return 'high';
    if (score >= 35) return 'medium';
    return 'low';
  }

  private isProcessableFile(att: GraphAttachment): boolean {
    const lower = att.name.toLowerCase();
    return (
      ALLOWED_MIMES.includes(att.contentType) ||
      ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext))
    );
  }

  /** Returns a relative path like "2024/04-April" */
  private suggestSubFolder(isoDate: string): string {
    const d = new Date(isoDate);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const monthName = d.toLocaleString('en-US', { month: 'long' });
    return `${year}/${month}-${monthName}`;
  }
}
