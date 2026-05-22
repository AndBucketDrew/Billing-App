/**
 * ImapClient — IMAP mail client using imapflow.
 *
 * Each public method opens a fresh connection, performs its work,
 * and logs out cleanly.  This is safe for the low-frequency polling
 * use case and avoids stale-connection issues.
 *
 * Attachment metadata discovered during getRecentMessages() is cached
 * in-memory so that getAttachments() can return immediately without
 * a second round-trip.  The cache is capped at CACHE_MAX entries to
 * prevent unbounded memory growth in long-running sessions.
 */

import { ImapFlow } from 'imapflow';
import type { IMailClient, MailMessage, MailAttachment } from './email-types';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ImapConfig {
  host: string;
  port: number;
  /** true = SSL/TLS (port 993), false = STARTTLS or plain (port 143) */
  secure: boolean;
  user: string;
  password: string;
  /**
   * When true, TLS certificate errors are ignored.
   * Only enable for servers with self-signed or provider-issued certificates
   * where the hostname does not match the certificate CN/SAN.
   * Defaults to false (certificates are verified — secure default).
   */
  ignoreCertErrors?: boolean;
}

// ─── Client ───────────────────────────────────────────────────────────────────

/** Maximum number of UID→attachments entries kept in the in-process cache. */
const CACHE_MAX = 500;

export class ImapClient implements IMailClient {
  /** Attachment metadata keyed by UID string, populated by getRecentMessages */
  private readonly cache = new Map<string, MailAttachment[]>();

  constructor(private readonly config: ImapConfig) {}

  // ─── Connection test ────────────────────────────────────────────────────────

  /**
   * Opens an authenticated connection and immediately logs out.
   * Throws a human-readable error on failure (auth failure, wrong host, cert issues, etc.)
   */
  async testConnection(): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
    } catch (err: any) {
      throw this.enrichError(err);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  // ─── Messages ───────────────────────────────────────────────────────────────

  async getRecentMessages(top = 50, since?: Date): Promise<MailMessage[]> {
    const client = this.createClient();
    const messages: MailMessage[] = [];

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // imapflow requires at least one search key — use 'all' when no date filter
        const criteria = since ? { since } : { all: true };
        // { uid: true } makes search return UIDs instead of sequence numbers
        const uids = await client.search(criteria, { uid: true }) as unknown as number[];

        // Guard moved inside the try so the lock is always released before returning
        if (uids && uids.length > 0) {
          // IMAP UIDs are ascending — take the last `top` to get the most recent
          const recentUids = uids.slice(-top);
          // imapflow fetch requires a sequence string, not an array
          const uidSeq = recentUids.join(',');

          for await (const msg of client.fetch(uidSeq, {
            uid: true,
            envelope: true,
            bodyStructure: true,
            // B3: fetch first MIME part (usually text/plain) for body preview scoring.
            // Part '1' covers simple and multipart/alternative messages; falls back
            // gracefully to '' when not present (e.g. HTML-only emails).
            bodyParts: ['1'],
          }, { uid: true })) {
            const uid = String(msg.uid);
            const env = msg.envelope as any;
            const from = env?.from?.[0];
            const attachments = this.extractAttachments((msg as any).bodyStructure);

            // Extract a short plain-text preview (max 200 chars) for heuristic scoring
            const rawBodyPart = (msg as any).bodyParts?.get('1') as Buffer | undefined;
            const bodyPreview = rawBodyPart
              ? rawBodyPart.toString('utf-8').replace(/[\r\n\t\s]+/g, ' ').trim().slice(0, 200)
              : '';

            // Cache so getAttachments() works without a second connection
            this.cacheSet(uid, attachments);

            messages.push({
              id: uid,
              subject: env?.subject ?? '(no subject)',
              from: {
                name: from?.name ?? from?.address ?? '',
                address: from?.address ?? '',
              },
              receivedDateTime: (env?.date instanceof Date ? env.date : new Date()).toISOString(),
              hasAttachments: attachments.length > 0,
              bodyPreview,
            });
          }
        }
      } finally {
        lock.release();
      }
    } catch (err: any) {
      throw this.enrichError(err);
    } finally {
      await client.logout().catch(() => {});
    }

    return messages;
  }

  // ─── Attachments ────────────────────────────────────────────────────────────

  /**
   * Returns attachment metadata for the given message UID.
   *
   * Hot path: returns from the in-memory cache populated by getRecentMessages().
   * Cold path (e.g. after app restart with a persisted review queue): opens a
   * fresh connection, fetches only the bodyStructure for that UID, then caches
   * the result so subsequent calls are free.
   */
  async getAttachments(messageId: string): Promise<MailAttachment[]> {
    const cached = this.cache.get(messageId);
    if (cached !== undefined) return cached;

    // Cache miss — fetch from the server (maintains the IMailClient contract)
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch(messageId, { bodyStructure: true }, { uid: true })) {
          const attachments = this.extractAttachments((msg as any).bodyStructure);
          this.cacheSet(messageId, attachments);
          return attachments;
        }
        // UID not found in mailbox — return empty and cache the result
        this.cacheSet(messageId, []);
        return [];
      } finally {
        lock.release();
      }
    } catch (err: any) {
      throw this.enrichError(err);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * Downloads the raw bytes of a specific attachment.
   * @param messageId  IMAP UID string
   * @param partNumber Body part number e.g. "2" or "1.2"
   */
  async downloadAttachment(messageId: string, partNumber: string): Promise<Buffer> {
    const client = this.createClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const dl = await client.download(messageId, partNumber, { uid: true });
        if (!dl) throw new Error(`Part ${partNumber} not found in message UID ${messageId}`);

        const chunks: Buffer[] = [];
        for await (const chunk of dl.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        return Buffer.concat(chunks);
      } finally {
        lock.release();
      }
    } catch (err: any) {
      throw this.enrichError(err);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private createClient(): ImapFlow {
    return new ImapFlow({
      host:   this.config.host,
      port:   this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.user,
        pass: this.config.password,
      },
      // Honour the per-account opt-in; default to strict verification (secure).
      // Set ignoreCertErrors = true only for servers whose cert CN/SAN does not
      // match the configured hostname (e.g. shared-hosting catch-all certs).
      tls: { rejectUnauthorized: !this.config.ignoreCertErrors },
      // Generous timeouts for slow shared-hosting servers
      connectionTimeout: 15000,
      greetingTimeout:   10000,
      socketTimeout:     30000,
      logger: false,
    });
  }

  /**
   * Converts an imapflow error into a human-readable message.
   * imapflow errors carry a `code` and `serverResponse` that are much more
   * useful than the generic "Command failed" message.
   * NOTE: user credentials are intentionally NOT logged here.
   */
  private enrichError(err: any): Error {
    if (!(err instanceof Error)) return new Error(String(err));

    const code: string   = (err as any).response ?? (err as any).code ?? '';
    const server: string = (err as any).serverResponse ?? '';

    // Log detail to the main-process console for debugging — no credentials
    console.error('[IMAP]', err.message, { code, server, host: this.config.host });

    if (/AUTHENTICATIONFAILED|authent|login|creden/i.test(code) || /authent|login|password|creden/i.test(server)) {
      return new Error(
        `Authentication failed — the username or password is incorrect.\n(server: ${server || code})`
      );
    }
    if ((err as any).code === 'ENOTFOUND' || (err as any).code === 'EAI_AGAIN') {
      return new Error(`Cannot reach server "${this.config.host}" — check the IMAP host setting.`);
    }
    if ((err as any).code === 'ECONNREFUSED') {
      return new Error(`Connection refused on port ${this.config.port} — check the port setting.`);
    }
    if ((err as any).code === 'ETIMEDOUT' || (err as any).code === 'ECONNRESET') {
      return new Error(`Connection timed out to ${this.config.host}:${this.config.port}`);
    }
    if (
      /CERT|certificate|self.signed|hostname/i.test(err.message) ||
      (err as any).code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      (err as any).code === 'CERT_HAS_EXPIRED' ||
      (err as any).code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    ) {
      return new Error(
        `TLS certificate error for "${this.config.host}". ` +
        `If you trust this server, enable "Ignore certificate errors" in IMAP Settings.`
      );
    }

    // Fall back to server response if it's more descriptive than "Command failed"
    const display = server && server !== err.message ? `${err.message}: ${server}` : err.message;
    return new Error(display);
  }

  /**
   * Recursively walks an imapflow bodyStructure tree and collects
   * all leaf parts that have a filename (attachments + inline files with names).
   */
  private extractAttachments(structure: any, results: MailAttachment[] = []): MailAttachment[] {
    if (!structure) return results;

    if (structure.childNodes?.length) {
      for (const child of structure.childNodes) {
        this.extractAttachments(child, results);
      }
    } else if (structure.part) {
      // Filename can live in disposition params or content-type params.
      // The `filename*` variant is RFC 2231 encoded (e.g. "UTF-8''Rechnung%20M%C3%A4rz.pdf")
      // and must be decoded; plain `filename` is already a decoded string.
      const filename: string =
        structure.dispositionParameters?.filename
        ?? decodeRfc2231(structure.dispositionParameters?.['filename*'])
        ?? structure.parameters?.name
        ?? decodeRfc2231(structure.parameters?.['name*'])
        ?? '';

      if (filename) {
        const contentType =
          `${structure.type ?? 'application'}/${structure.subtype ?? 'octet-stream'}`.toLowerCase();
        const disposition = (structure.disposition ?? '').toLowerCase();

        results.push({
          id: structure.part,
          name: filename,
          contentType,
          size: structure.size ?? 0,
          isInline: disposition === 'inline',
        });
      }
    }

    return results;
  }

  /**
   * Bounded cache insert — evicts the oldest entry (insertion order) when
   * the cap is reached, preventing unbounded memory growth over long sessions.
   */
  private cacheSet(uid: string, attachments: MailAttachment[]): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(uid, attachments);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decodes an RFC 2231 encoded MIME parameter value.
 * Format: charset'language'percent-encoded-value
 * Example: "UTF-8''Rechnung%20M%C3%A4rz.pdf" → "Rechnung März.pdf"
 *
 * Returns undefined when value is absent/empty so callers can use ?? chaining.
 * Returns the raw value unchanged when it does not match the RFC 2231 pattern
 * (i.e. plain filenames pass through unmodified).
 */
function decodeRfc2231(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^([^']*)'([^']*)'(.+)$/.exec(value);
  if (!match) return value; // not RFC 2231 — return as-is
  try {
    return decodeURIComponent(match[3]) || undefined;
  } catch {
    return value; // malformed percent-encoding — return raw
  }
}
