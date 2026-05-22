/**
 * GraphClient — minimal Microsoft Graph v1 wrapper.
 *
 * Implements IMailClient so it can be used interchangeably with ImapClient
 * in the mail poller and invoice detector pipeline.
 *
 * Uses Node's built-in fetch (available in Electron 29 / Node 20).
 * All network calls go through getAccessToken(), which auto-refreshes.
 * Access tokens never leave the main process.
 *
 * Resilience:
 *   - 429 / 5xx responses are retried up to MAX_RETRIES times with
 *     exponential back-off; the Retry-After header is honoured when present.
 *   - Results are paginated automatically via @odata.nextLink so no
 *     messages are silently dropped when the mailbox exceeds $top items.
 */

import { MsalAuthService } from '../auth/msal-auth';
import type { IMailClient, MailMessage, MailAttachment } from '../imap/email-types';

const BASE = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 3;
/** Graph API maximum page size for the messages endpoint */
const GRAPH_PAGE_SIZE = 50;
/** Hard ceiling on any Retry-After delay — prevents a server from stalling the poller indefinitely */
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// ─── Graph-API-specific DTOs (internal only) ─────────────────────────────────

interface GraphMessage {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  hasAttachments: boolean;
  bodyPreview: string;
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

interface GraphPagedResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class GraphClient implements IMailClient {
  constructor(private readonly auth: MsalAuthService) {}

  // ─── IMailClient ───────────────────────────────────────────────────────────

  async getRecentMessages(top = 50, since?: Date): Promise<MailMessage[]> {
    const gms = await this.fetchGraphMessages(top, since);
    return gms.map(gm => ({
      id: gm.id,
      subject: gm.subject,
      from: {
        name: gm.from.emailAddress.name,
        address: gm.from.emailAddress.address,
      },
      receivedDateTime: gm.receivedDateTime,
      hasAttachments: gm.hasAttachments,
      bodyPreview: gm.bodyPreview,
    }));
  }

  async getAttachments(messageId: string): Promise<MailAttachment[]> {
    const gas = await this.fetchGraphAttachments(messageId);
    return gas.map(ga => ({
      id: ga.id,
      name: ga.name,
      contentType: ga.contentType,
      size: ga.size,
      isInline: ga.isInline,
    }));
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const token = await this.auth.getAccessToken();
    const url = `${BASE}/me/messages/${enc(messageId)}/attachments/${enc(attachmentId)}/$value`;
    const response = await this.fetchWithRetry(url, token);
    return Buffer.from(await response.arrayBuffer());
  }

  // ─── Internal Graph helpers ────────────────────────────────────────────────

  private async fetchGraphMessages(top = 50, since?: Date): Promise<GraphMessage[]> {
    let filter = 'hasAttachments eq true';
    if (since) {
      filter += ` and receivedDateTime ge ${since.toISOString()}`;
    }

    const params = new URLSearchParams({
      $top: String(GRAPH_PAGE_SIZE),
      $filter: filter,
      $select: 'id,subject,from,receivedDateTime,hasAttachments,bodyPreview',
      $orderby: 'receivedDateTime desc',
    });

    // Follow @odata.nextLink pages until we have enough messages or no more pages
    const collected: GraphMessage[] = [];
    let nextUrl: string | undefined = `${BASE}/me/messages?${params}`;

    while (nextUrl && collected.length < top) {
      const res: GraphPagedResponse<GraphMessage> = await this.get(nextUrl);
      collected.push(...res.value);
      nextUrl = res['@odata.nextLink'];
    }

    return collected.slice(0, top);
  }

  private async fetchGraphAttachments(messageId: string): Promise<GraphAttachment[]> {
    const res = await this.get<GraphPagedResponse<GraphAttachment>>(
      `${BASE}/me/messages/${enc(messageId)}/attachments` +
        `?$select=id,name,contentType,size,isInline`,
    );
    return res.value;
  }

  private async get<T>(url: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    const response = await this.fetchWithRetry(url, token);
    return (await response.json()) as T;
  }

  /**
   * Fetch with automatic retry on 429 / 5xx responses.
   * Respects the Retry-After header; falls back to exponential back-off.
   * Re-acquires a fresh token after each sleep in case it expired during the wait.
   */
  private async fetchWithRetry(
    url: string,
    token: string,
    retries = MAX_RETRIES,
  ): Promise<Response> {
    let currentToken = token;

    for (let attempt = 1; attempt <= retries; attempt++) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });

      if (response.ok) return response;

      const isRetryable = response.status === 429 || response.status >= 500;

      if (isRetryable && attempt < retries) {
        const rawDelay = parseRetryAfter(response.headers.get('Retry-After')) ?? 2 ** attempt * 1000;
        const delayMs = Math.min(rawDelay, MAX_RETRY_DELAY_MS); // S1: cap so a server can't stall us indefinitely
        await sleep(delayMs);
        // Re-acquire token in case it expired during the wait
        currentToken = await this.auth.getAccessToken();
        continue;
      }

      // Truncate the error body — full Graph error responses can contain
      // internal resource IDs and should not be forwarded verbatim to the UI.
      const body = await response.text().catch(() => '');
      const preview = body.length > 120 ? `${body.slice(0, 120)}…` : body;
      throw new Error(`Graph API error ${response.status}: ${preview}`);
    }

    /* istanbul ignore next */
    throw new Error('fetchWithRetry: retry loop exhausted without response');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Encode a Graph path segment safely */
function enc(s: string): string {
  return encodeURIComponent(s);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse the value of a Retry-After header and return the number of
 * milliseconds to wait.  The HTTP spec allows two formats:
 *   • delay-seconds  e.g. "30"
 *   • HTTP-date      e.g. "Fri, 21 Dec 2025 08:00:00 GMT"
 * Returns undefined if the header is absent or unparseable.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  // Try integer seconds first
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) return seconds * 1000;

  // Fall back to HTTP-date
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }

  return undefined;
}
