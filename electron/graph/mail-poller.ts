/**
 * MailPoller — background service that periodically checks for new emails.
 *
 * Works with any IMailClient backend (GraphClient for Microsoft 365,
 * ImapClient for IMAP/SMTP accounts, MockMailClient for development).
 *
 * Push events sent to the renderer via IPC:
 *   'outlook:invoicesDetected'  — DetectedInvoice[]
 *   'outlook:pollComplete'      — { checkedAt: string; found: number }
 *   'outlook:pollError'         — string (error message)
 *
 * The poller keeps track of the last check time so it never re-processes
 * emails it has already seen in the current session.
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { IMailClient } from '../imap/email-types';
import { InvoiceDetector, DetectedInvoice } from '../invoice-detector/invoice-detector';

const STATE_FILENAME = 'outlook-poll-state.json';
const FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface PollerOptions {
  trustedSenders?: string[];
  onAutoSave?: (invoice: DetectedInvoice) => Promise<void>;
  /** Stamped on detected invoices — lets the UI warn on backend switch between sessions. */
  connectionType?: string;
}

export class MailPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private pollInProgress = false;
  private lastChecked: Date;
  private readonly stateFile: string;
  private trustedSenders: string[] = [];
  private connectionType = '';
  private onAutoSave?: (invoice: DetectedInvoice) => Promise<void>;

  constructor(
    private readonly client: IMailClient,
    /** Getter instead of direct reference — window may be recreated */
    private readonly getWindow: () => BrowserWindow | null,
    stateDir: string,
    /** Shared detector instance — injected to avoid duplicate construction. */
    private readonly detector: InvoiceDetector,
  ) {
    this.stateFile = path.join(stateDir, STATE_FILENAME);
    this.lastChecked = this.loadLastChecked();
  }

  // ─── Control ───────────────────────────────────────────────────────────────

  start(intervalMs = 5 * 60 * 1000, options: PollerOptions = {}): void {
    if (this.isRunning) return;
    this.trustedSenders = options.trustedSenders ?? [];
    this.connectionType = options.connectionType ?? '';
    this.onAutoSave = options.onAutoSave;
    this.isRunning = true;

    // Fire immediately, then on each interval
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  /**
   * Stops the poller.
   *
   * @param silent  When true the 'outlook:pollerStopped' push event is suppressed.
   *                Use this for internal config-only restarts where polling is
   *                immediately resumed — emitting the event would leave the UI
   *                stuck at isPolling=false even though polling continues. (B_NEW_2)
   */
  stop(silent = false): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    // A3: notify the renderer so its isPolling indicator stays in sync when
    // the poller is genuinely stopped (user-initiated or error-triggered).
    if (!silent) {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('outlook:pollerStopped');
      }
    }
  }

  get running(): boolean {
    return this.isRunning;
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    // Skip if a poll is already in-flight — prevents overlapping network calls
    // when the interval fires before the previous poll completes.
    if (this.pollInProgress) return;
    this.pollInProgress = true;

    const win = this.getWindow();
    if (!win || win.isDestroyed()) {
      this.pollInProgress = false;
      return;
    }

    const since = this.lastChecked;
    this.lastChecked = new Date(); // advance before await to avoid duplicate window

    try {
      const messages = await this.client.getRecentMessages(50, since);
      const detected: DetectedInvoice[] = [];

      for (const msg of messages) {
        if (!msg.hasAttachments) continue;

        try {
          const attachments = await this.client.getAttachments(msg.id);
          detected.push(...this.detector.analyze(msg, attachments, this.trustedSenders, this.connectionType));
        } catch (attachErr: unknown) {
          // Best-effort: skip this message if its attachment fetch fails.
          // Log for diagnosability without crashing the entire poll window. (B_NEW_3)
          console.warn('[poll] attachment fetch failed for msg', msg.id,
            attachErr instanceof Error ? attachErr.message : String(attachErr));
          // lastChecked was already advanced before the loop started, so this
          // message will NOT be retried on the next poll.  This is intentional —
          // a transient error on a single message should not stall the entire
          // polling window.  If the outer getRecentMessages() call itself throws,
          // lastChecked is rolled back in the catch block below and the whole
          // window is retried.
        }
      }

      // Auto-save high-confidence invoices before notifying the UI
      if (this.onAutoSave) {
        for (const inv of detected) {
          if (inv.confidence === 'high') {
            try {
              await this.onAutoSave(inv);
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              // B7: re-check — window may have closed while auto-save was in flight
              if (!win.isDestroyed()) {
                win.webContents.send('outlook:autoSaveError', { invoice: inv, error: message });
              }
            }
          }
        }
      }

      this.saveLastChecked(this.lastChecked);

      // B7 pattern extended: re-acquire the window — it may have been destroyed
      // during the autoSave await loop (network I/O can take several seconds).
      const finalWin = this.getWindow();
      if (!finalWin || finalWin.isDestroyed()) return;

      if (detected.length > 0) {
        finalWin.webContents.send('outlook:invoicesDetected', detected);
      }

      finalWin.webContents.send('outlook:pollComplete', {
        checkedAt: this.lastChecked.toISOString(),
        found: detected.length,
      });
    } catch (err: unknown) {
      // Roll back so the failed window is retried on the next poll
      this.lastChecked = since;
      const message = err instanceof Error ? err.message : String(err);
      const w = this.getWindow();
      w?.webContents.send('outlook:pollError', message);
    } finally {
      this.pollInProgress = false;
    }
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  private loadLastChecked(): Date {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf-8');
      const { lastChecked } = JSON.parse(raw);
      const d = new Date(lastChecked);
      if (!isNaN(d.getTime())) return d;
    } catch {
      // file absent or corrupt — fall through to default
    }
    return new Date(Date.now() - FALLBACK_LOOKBACK_MS);
  }

  private saveLastChecked(d: Date): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ lastChecked: d.toISOString() }));
    } catch {
      // non-fatal: worst case we re-scan a small window on next restart
    }
  }
}
