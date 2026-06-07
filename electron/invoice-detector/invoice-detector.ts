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
  'invoice', 'rechnung', 're nr',  // 're nr' = Austrian abbrev. for "Rechnung Nr."
  'bill', 'faktura', 'factura', 'fattura',
  'quittung', 'receipt', 'zahlungsbeleg', 'gutschrift', 'abrechnung', 'honorarnote',
];

const SUBJECT_KEYWORDS = [
  'invoice', 'rechnung', 'bill', 'payment', 'zahlung', 'faktura',
  'your order', 'ihre bestellung', 'purchase', 'kauf', 'receipt',
  'order confirmation', 'bestellbestätigung', 'bestellung', 'abrechnung', 'honorarnote',
];

/**
 * Subset of SUBJECT_KEYWORDS that are unambiguous invoice terms.
 * When one of these appears in the email *body* it earns a larger bonus (+20)
 * so that emails like "Beiliegend finden Sie die Rechnung AR260259" + PDF
 * reach the 35-pt medium threshold even with no keyword in subject/filename.
 * Weaker terms ("payment", "zahlung", "kauf"…) keep the original +5 bonus.
 */
const STRONG_BODY_KEYWORDS = new Set([
  'invoice', 'rechnung', 'faktura', 'factura', 'fattura',
  'honorarnote', 'gutschrift', 'abrechnung', 'quittung', 'zahlungsbeleg',
  'receipt',  // PayPal-style body-only receipts: "Your recent transaction receipt"
]);

/**
 * Subject prefixes that indicate a forwarded email.
 * A forwarded PDF is almost always intentional, so it warrants a higher baseline score.
 */
const FORWARD_PREFIXES = ['fwd:', 'fw:', 'wg:', 'weitergeleitet:', 'tr:', 'vl:'];

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

/**
 * Brand-name labels for the brands already in COMMERCIAL_DOMAINS.
 * Used as a fallback to match international TLD variants (paypal.at, paypal.de, …)
 * that are not listed explicitly above. The scorer extracts the registerable-domain
 * label from the sender and checks it against this set.
 */
const INTERNATIONAL_BRANDS = new Set([
  'paypal', 'amazon', 'ebay', 'stripe', 'paddle', 'fastspring',
  'booking', 'airbnb', 'microsoft', 'google', 'apple',
]);

const PDF_MIME = 'application/pdf';
const DOCX_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];
const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.docx', '.doc'];
const ALLOWED_MIMES = [PDF_MIME, ...DOCX_MIMES, 'image/jpeg', 'image/png', 'image/tiff'];

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
      // Only skip inline image attachments (embedded logos/signatures in HTML body).
      // Documents (PDFs, Word files) are never genuinely inline — some mail clients
      // mis-set the disposition flag but the file is always a real attachment.
      if (att.isInline && att.contentType.startsWith('image/')) continue;
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

    // ── TNEF fallback ─────────────────────────────────────────────────────────
    // Outlook (even on Gmail accounts) sometimes sends Rich Text Format emails
    // that wrap attachments inside a winmail.dat (TNEF) file.  The actual PDF
    // is invisible to standard MIME parsing.  When no processable attachment
    // was found but a TNEF blob is present, score the message on subject/sender
    // alone and surface it in the queue so the user knows to open it manually.
    if (results.length === 0) {
      const tnef = attachments.find(a =>
        !a.isInline && (
          a.contentType === 'application/ms-tnef' ||
          a.name.toLowerCase() === 'winmail.dat'
        )
      );
      if (tnef) {
        // Score with an empty-name placeholder — only subject/sender/body fire.
        const phantom: MailAttachment = { ...tnef, name: '', contentType: '' };
        const { score, reasons } = this.score(message, phantom, trustedSenders);
        // TNEF containers always hold at least one real attachment inside.
        // A 10-pt bonus ensures that an "invoice"-subject email (30 pts from
        // subject alone) clears the 35-pt medium threshold rather than being
        // silently dropped as low confidence.
        const adjustedScore = Math.min(score + 10, 100);
        const confidence = this.toConfidence(adjustedScore);
        if (confidence !== 'low') {
          results.push({
            messageId: message.id,
            attachmentId: tnef.id,
            senderName: message.from.name,
            senderEmail: message.from.address,
            subject: message.subject ?? '(no subject)',
            receivedAt: message.receivedDateTime,
            attachmentName: tnef.name,
            attachmentSize: tnef.size,
            confidence,
            confidenceScore: adjustedScore,
            reasons: [...reasons, 'Attachment is TNEF-encoded (winmail.dat) — open in Outlook to extract the actual file'],
            suggestedSubFolder: this.suggestSubFolder(message.receivedDateTime),
            connectionType,
          });
        }
      }
    }

    // ── No-attachment fallback ────────────────────────────────────────────────
    // Called when the server confirms there ARE attachments (message.hasAttachments)
    // but none could be retrieved (empty list passed by the caller after a fetch
    // failure).  Score on subject/sender/body only.  "invoice" in subject alone
    // gives 30 pts; with a matching body-preview keyword it reaches 35 → medium.
    if (results.length === 0 && message.hasAttachments && attachments.length === 0) {
      const phantom: MailAttachment = { id: '', name: '', contentType: '', size: 0, isInline: false };
      const { score, reasons } = this.score(message, phantom, trustedSenders);
      const confidence = this.toConfidence(score);
      if (confidence !== 'low') {
        results.push({
          messageId: message.id,
          attachmentId: '',
          senderName: message.from.name,
          senderEmail: message.from.address,
          subject: message.subject ?? '(no subject)',
          receivedAt: message.receivedDateTime,
          attachmentName: '(attachment details unavailable)',
          attachmentSize: 0,
          confidence,
          confidenceScore: score,
          reasons: [...reasons, 'Attachment details could not be retrieved — confirm manually before saving'],
          suggestedSubFolder: this.suggestSubFolder(message.receivedDateTime),
          connectionType,
        });
      }
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
    } else {
      // Brand-name match across any TLD: paypal.at, paypal.de, amazon.at, etc.
      // Extract the registerable-domain label: the label just before the TLD,
      // or one level higher for 2-letter SLD + 2-letter TLD pairs (e.g. co.uk).
      const parts = senderDomain.split('.');
      const last       = parts[parts.length - 1] ?? '';
      const secondLast = parts[parts.length - 2] ?? '';
      const brandLabel =
        last.length === 2 && secondLast.length === 2 && parts.length >= 3
          ? parts[parts.length - 3]   // amazon.co.uk → 'amazon'
          : secondLast;               // paypal.at → 'paypal'
      if (brandLabel && INTERNATIONAL_BRANDS.has(brandLabel)) {
        total += 10;
        reasons.push(`Known commercial sender (${brandLabel}.*)`);
      }
    }

    // ── Body preview keyword (0–20) ─────────────────────────────────────────
    // Strong terms ("rechnung", "invoice" …) earn +20 so that a plain
    // PDF(15) + body(20) = 35 reaches the medium threshold even when the
    // subject and filename carry no invoice signal.  Weaker terms keep +5.
    const lowerBody = (message.bodyPreview ?? '').toLowerCase();
    const bodyKw = SUBJECT_KEYWORDS.find(kw => lowerBody.includes(kw));
    if (bodyKw) {
      const bodyBonus = STRONG_BODY_KEYWORDS.has(bodyKw) ? 20 : 5;
      total += bodyBonus;
      reasons.push('Invoice keyword in email body');
    }

    // ── Forwarded email (0–20) ───────────────────────────────────────────────
    // Users forward invoices intentionally to their monitored address.
    // A forwarded PDF with no other signals gets 15 (PDF) + 20 = 35, exactly
    // at the medium threshold so it surfaces for manual confirmation.
    const isForwarded = FORWARD_PREFIXES.some(p => lowerSubject.startsWith(p));
    if (isForwarded) {
      total += 20;
      reasons.push('Forwarded email');
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
