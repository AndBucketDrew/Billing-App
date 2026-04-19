/**
 * GraphClient — minimal Microsoft Graph v1 wrapper.
 *
 * Uses Node's built-in fetch (available in Electron 29 / Node 20).
 * All network calls go through getAccessToken(), which auto-refreshes.
 * Access tokens never leave the main process.
 */

import { MsalAuthService } from '../auth/msal-auth';

const BASE = 'https://graph.microsoft.com/v1.0';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface GraphMessage {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  hasAttachments: boolean;
  bodyPreview: string;
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class GraphClient {
  constructor(private readonly auth: MsalAuthService) {}

  // ─── Messages ──────────────────────────────────────────────────────────────

  /**
   * Fetches recent messages that have attachments.
   * @param top   Max results (default 50)
   * @param since Only messages received after this date
   */
  async getRecentMessages(top = 50, since?: Date): Promise<GraphMessage[]> {
    let filter = 'hasAttachments eq true';
    if (since) {
      filter += ` and receivedDateTime ge ${since.toISOString()}`;
    }

    const params = new URLSearchParams({
      $top: String(top),
      $filter: filter,
      $select: 'id,subject,from,receivedDateTime,hasAttachments,bodyPreview',
      $orderby: 'receivedDateTime desc',
    });

    const res = await this.get<{ value: GraphMessage[] }>(`/me/messages?${params}`);
    return res.value;
  }

  // ─── Attachments ───────────────────────────────────────────────────────────

  /**
   * Lists attachment metadata for a message.
   * Does NOT download content — use downloadAttachment() for that.
   */
  async getAttachments(messageId: string): Promise<GraphAttachment[]> {
    const res = await this.get<{ value: GraphAttachment[] }>(
      `/me/messages/${enc(messageId)}/attachments` +
        `?$select=id,name,contentType,size,isInline`,
    );
    return res.value;
  }

  /**
   * Downloads the raw binary content of an attachment.
   * Uses the /$value endpoint which returns the file bytes directly.
   */
  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const token = await this.auth.getAccessToken();

    const response = await fetch(
      `${BASE}/me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/$value`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) {
      throw new Error(`Attachment download failed: HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const token = await this.auth.getAccessToken();

    const response = await fetch(`${BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Graph API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }
}

// Encode path segment safely
function enc(s: string): string {
  return encodeURIComponent(s);
}
