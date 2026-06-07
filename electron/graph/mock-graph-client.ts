/**
 * MockMailClient — drop-in replacement for GraphClient / ImapClient used during development.
 *
 * Activate by setting clientId = "mock" (MSAL mode) or imapHost = "mock" (IMAP mode)
 * in Outlook Settings.  Returns a fixed set of fake emails that exercise all three
 * confidence levels:
 *
 *   high   → invoice_2024_07_001.pdf from amazon-billing@amazon.com
 *   high   → Rechnung_Stripe.pdf from billing@stripe.com  (trusted-sender demo)
 *   medium → order-summary.jpg from noreply@somestore.com
 *   low    → photo.jpg from friend@example.com  (silently filtered by InvoiceDetector)
 *
 * B2 FIX: message timestamps are generated fresh on every getRecentMessages() call
 * so they stay ahead of the poller's lastChecked cursor and don't go stale after
 * ~2 hours of running.
 */

import type { IMailClient, MailMessage, MailAttachment } from '../imap/email-types';

// Minimal fake PDF bytes so downloadAttachment returns something non-empty
const FAKE_PDF = Buffer.from('%PDF-1.4 1 0 obj<</Type/Catalog>>endobj\n%%EOF');
const FAKE_IMG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic bytes

/** Generates fresh message list with timestamps relative to right now. */
function makeMessages(): MailMessage[] {
  const now = Date.now();
  return [
    {
      id: 'mock-msg-1',
      subject: 'Your Invoice #2024-07-001',
      from: { name: 'Amazon', address: 'amazon-billing@amazon.com' },
      receivedDateTime: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      hasAttachments: true,
      bodyPreview: 'Please find your invoice attached.',
    },
    {
      id: 'mock-msg-2',
      subject: 'Stripe Payment Receipt',
      from: { name: 'Stripe', address: 'billing@stripe.com' },
      receivedDateTime: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
      hasAttachments: true,
      bodyPreview: 'Your payment was successful.',
    },
    {
      id: 'mock-msg-3',
      subject: 'Your Order Confirmation',
      from: { name: 'Some Store', address: 'noreply@somestore.com' },
      receivedDateTime: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
      hasAttachments: true,
      bodyPreview: 'Thank you for your purchase.',
    },
    {
      id: 'mock-msg-4',
      subject: 'Holiday photos!',
      from: { name: 'Friend', address: 'friend@example.com' },
      receivedDateTime: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      hasAttachments: true,
      bodyPreview: 'Check out these photos from the trip.',
    },
  ];
}

const ATTACHMENTS: Record<string, MailAttachment[]> = {
  'mock-msg-1': [
    {
      id: 'mock-att-1a',
      name: 'invoice_2024_07_001.pdf',
      contentType: 'application/pdf',
      size: FAKE_PDF.length,
      isInline: false,
    },
  ],
  'mock-msg-2': [
    {
      id: 'mock-att-2a',
      name: 'Rechnung_Stripe_July2024.pdf',
      contentType: 'application/pdf',
      size: FAKE_PDF.length,
      isInline: false,
    },
  ],
  'mock-msg-3': [
    {
      id: 'mock-att-3a',
      name: 'order-summary.jpg',
      contentType: 'image/jpeg',
      size: FAKE_IMG.length,
      isInline: false,
    },
  ],
  'mock-msg-4': [
    {
      id: 'mock-att-4a',
      name: 'photo.jpg',
      contentType: 'image/jpeg',
      size: FAKE_IMG.length,
      isInline: false,
    },
  ],
};

export class MockMailClient implements IMailClient {
  async getRecentMessages(top = 50, since?: Date): Promise<MailMessage[]> {
    // Fresh timestamps on every call — keeps the mock alive across long sessions (B2)
    const messages = makeMessages();
    const filtered = since
      ? messages.filter(m => new Date(m.receivedDateTime) > since)
      : messages;
    return filtered.slice(0, top);
  }

  async getAttachments(messageId: string): Promise<MailAttachment[]> {
    return ATTACHMENTS[messageId] ?? [];
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const att = (ATTACHMENTS[messageId] ?? []).find(a => a.id === attachmentId);
    if (!att) throw new Error(`Mock: attachment ${attachmentId} not found`);
    return att.contentType === 'application/pdf' ? FAKE_PDF : FAKE_IMG;
  }

  async getMessageBody(_messageId: string): Promise<string> {
    return 'Mock email body.';
  }
}

/** @deprecated Use MockMailClient — kept as alias to avoid import-not-found errors during migration */
export { MockMailClient as MockGraphClient };
