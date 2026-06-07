/**
 * Generic email types used across the IMAP client, mail poller,
 * and invoice detector.  These replace the Microsoft Graph-specific
 * GraphMessage / GraphAttachment interfaces so the rest of the code
 * has no Azure dependency.
 */

// ─── Message & Attachment DTOs ────────────────────────────────────────────────

export interface MailMessage {
  /** IMAP UID (as string) or any stable unique message identifier */
  id: string;
  subject: string;
  from: { name: string; address: string };
  /** ISO 8601 */
  receivedDateTime: string;
  hasAttachments: boolean;
  /** First ~200 chars of the plain-text body, or empty string */
  bodyPreview: string;
}

export interface MailAttachment {
  /** IMAP body part number e.g. "2" or "1.2", or any opaque ID */
  id: string;
  name: string;
  /** MIME type e.g. "application/pdf" */
  contentType: string;
  /** Size in bytes */
  size: number;
  isInline: boolean;
}

// ─── Client interface ─────────────────────────────────────────────────────────

/**
 * Minimal interface any mail backend must satisfy.
 * Both ImapClient and MockMailClient implement this.
 */
export interface IMailClient {
  getRecentMessages(top: number, since?: Date): Promise<MailMessage[]>;
  getAttachments(messageId: string): Promise<MailAttachment[]>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  /** Fetches the plain-text body of a message (HTML tags stripped). */
  getMessageBody(messageId: string): Promise<string>;
}
