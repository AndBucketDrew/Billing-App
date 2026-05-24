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

import type { MailMessage, MailAttachment } from '../imap/email-types';

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
  /**
   * The mail backend that produced this invoice — 'msal', 'imap', or 'mock'.
   * Persisted in the review queue so the UI can warn when the user has switched
   * backends between sessions (a silent download failure otherwise).
   */
  connectionType: string;
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

/**
 * Known commercial sender domains — full registrable domain (e.g. "stripe.com").
 * The scorer checks whether the sender's domain equals an entry exactly OR is a
 * subdomain of it (e.g. "billing.stripe.com" matches "stripe.com").
 * Do NOT use bare names like "stripe" — they never match real addresses.
 */
const COMMERCIAL_DOMAINS = [
  // Shopping / marketplaces
  'amazon.com', 'amazon.de', 'amazon.co.uk', 'amazon.at', 'amazon.fr', 'amazon.it', 'amazon.es',
  'ebay.com', 'ebay.de', 'ebay.at', 'ebay.co.uk',
  // Payment processors
  'paypal.com', 'stripe.com', 'paddle.com', 'fastspring.com',
  // Software / cloud
  'microsoft.com', 'google.com', 'apple.com',
  // Travel / accommodation
  'booking.com', 'airbnb.com',
];

const PDF_MIME = 'application/pdf';
const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.tiff'];
const ALLOWED_MIMES = [PDF_MIME, 'image/jpeg', 'image/png', 'image/tiff'];

// ─── Detector ─────────────────────────────────────────────────────────────────

export class InvoiceDetector {
  constructor(private readonly locale: string = 'en-US') {}

  /**
   * Analyses a single email + its attachment list.
   * Returns one DetectedInvoice per qualifying attachment (low confidence excluded).
   */
  analyze(
    message: MailMessage,
    attachments: MailAttachment[],
    trustedSenders: string[] = [],
    /** Stamped on every result — lets the UI warn when the backend has changed between sessions. */
    connectionType = '',
  ): DetectedInvoice[] {
    const results: DetectedInvoice[] = [];

    for (const att of attachments) {
      if (att.isInline) continue;
      if (!this.isProcessableFile(att)) continue;

      const { score, reasons } = this.score(message, att, trustedSenders);
      const confidence = this.toConfidence(score);

      if (confidence === 'low') continue;

      results.push({
        messageId: message.id,
        attachmentId: att.id,
        senderName: message.from.name,
        senderEmail: message.from.address,
        subject: message.subject ?? '(no subject)',
        receivedAt: message.receivedDateTime,
        attachmentName: att.name,
        attachmentSize: att.size,
        confidence,
        confidenceScore: score,
        reasons,
        suggestedSubFolder: this.suggestSubFolder(message.receivedDateTime),
        connectionType,
      });
    }

    return results;
  }

  // ─── Scoring ───────────────────────────────────────────────────────────────

  private score(
    message: MailMessage,
    att: MailAttachment,
    trustedSenders: string[] = [],
  ): { score: number; reasons: string[] } {
    let total = 0;
    const reasons: string[] = [];

    // ── Trusted sender (guarantees high confidence regardless of other signals)
    // Short-circuit immediately: no other signal can change the outcome and
    // continuing would add irrelevant entries to the reasons array.
    const lowerSenderEmail = message.from.address.toLowerCase();
    if (trustedSenders.some(s => s.toLowerCase() === lowerSenderEmail)) {
      return { score: 100, reasons: [`Trusted sender (${message.from.address})`] };
    }

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
    // Extract the domain part after '@' to avoid matching spoofed addresses like
    // "fakepaypal@evil.com" which would pass an includes() check.
    const senderDomain = lowerSenderEmail.split('@')[1] ?? '';
    const domain = COMMERCIAL_DOMAINS.find(d => senderDomain === d || senderDomain.endsWith(`.${d}`));
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

  private isProcessableFile(att: MailAttachment): boolean {
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
    const monthName = d.toLocaleString(this.locale, { month: 'long' });
    return `${year}/${month}-${monthName}`;
  }
}
