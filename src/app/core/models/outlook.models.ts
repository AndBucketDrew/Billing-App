/**
 * Outlook / invoice-detection types shared between the Angular UI and the
 * Electron main process. These are plain interfaces — no Angular dependencies.
 *
 * The canonical runtime types live in the electron layer; these definitions
 * mirror them so the renderer has full TypeScript support without importing
 * from electron source files.
 */

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface DetectedInvoice {
  messageId: string;
  attachmentId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedAt: string;
  attachmentName: string;
  /** Bytes */
  attachmentSize: number;
  confidence: ConfidenceLevel;
  /** 0–100 */
  confidenceScore: number;
  /** Human-readable reasons for the score */
  reasons: string[];
  /** Relative sub-folder, e.g. "2024/04-April" */
  suggestedSubFolder: string;
}

export interface OutlookAccount {
  name: string;
  username: string;
}

export interface OutlookSettings {
  clientId: string;
  inboxFolder: string;
  pollIntervalMinutes: number;
}

/** UI-only state attached to a detected invoice during the review session */
export type InvoiceReviewStatus = 'pending' | 'confirmed' | 'rejected' | 'saving' | 'saved';

export interface InvoiceReviewItem {
  invoice: DetectedInvoice;
  status: InvoiceReviewStatus;
  /** Overridden by the user via the folder picker */
  targetFolder?: string;
  savedPath?: string;
  error?: string;
}
