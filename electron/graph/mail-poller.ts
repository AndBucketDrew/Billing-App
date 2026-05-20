/**
 * MailPoller — background service that periodically checks for new emails.
 *
 * When new invoices are detected it pushes them to the renderer via IPC:
 *   'outlook:invoicesDetected'  — DetectedInvoice[]
 *   'outlook:pollComplete'      — { checkedAt: string; found: number }
 *   'outlook:pollError'         — string (error message)
 *
 * The poller keeps track of the last check time so it never re-processes
 * emails it has already seen in the current session.
 */

import { BrowserWindow, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { GraphClient } from './graph-client';
import { InvoiceDetector, DetectedInvoice } from '../invoice-detector/invoice-detector';

const STATE_FILENAME = 'outlook-poll-state.json';
const FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface PollerOptions {
  trustedSenders?: string[];
  onAutoSave?: (invoice: DetectedInvoice) => Promise<void>;
}

export class MailPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastChecked: Date;
  private readonly detector = new InvoiceDetector(app.getLocale());
  private readonly stateFile: string;
  private trustedSenders: string[] = [];
  private onAutoSave?: (invoice: DetectedInvoice) => Promise<void>;

  constructor(
    private readonly graph: GraphClient,
    /** Getter instead of direct reference — window may be recreated */
    private readonly getWindow: () => BrowserWindow | null,
    stateDir: string,
  ) {
    this.stateFile = path.join(stateDir, STATE_FILENAME);
    this.lastChecked = this.loadLastChecked();
  }

  // ─── Control ───────────────────────────────────────────────────────────────

  start(intervalMs = 5 * 60 * 1000, options: PollerOptions = {}): void {
    if (this.isRunning) return;
    this.trustedSenders = options.trustedSenders ?? [];
    this.onAutoSave = options.onAutoSave;
    this.isRunning = true;

    // Fire immediately, then on each interval
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  get running(): boolean {
    return this.isRunning;
  }

  // ─── Poll ──────────────────────────────────────────────────────────────────

  async poll(): Promise<void> {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;

    const since = this.lastChecked;
    this.lastChecked = new Date(); // advance before await to avoid duplicate window

    try {
      const messages = await this.graph.getRecentMessages(50, since);
      const detected: DetectedInvoice[] = [];

      for (const msg of messages) {
        if (!msg.hasAttachments) continue;

        try {
          const attachments = await this.graph.getAttachments(msg.id);
          detected.push(...this.detector.analyze(msg, attachments, this.trustedSenders));
        } catch {
          // Skip this message on attachment fetch failure; it will be retried next poll
          // because lastChecked is only advanced after the full loop succeeds.
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
              win.webContents.send('outlook:autoSaveError', { invoice: inv, error: message });
            }
          }
        }
      }

      this.saveLastChecked(this.lastChecked);

      if (detected.length > 0) {
        win.webContents.send('outlook:invoicesDetected', detected);
      }

      win.webContents.send('outlook:pollComplete', {
        checkedAt: this.lastChecked.toISOString(),
        found: detected.length,
      });
    } catch (err: unknown) {
      // Roll back so the failed window is retried on the next poll
      this.lastChecked = since;
      const message = err instanceof Error ? err.message : String(err);
      const w = this.getWindow();
      w?.webContents.send('outlook:pollError', message);
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
