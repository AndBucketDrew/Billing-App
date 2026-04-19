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

import { BrowserWindow } from 'electron';
import { GraphClient } from './graph-client';
import { InvoiceDetector, DetectedInvoice } from '../invoice-detector/invoice-detector';

export class MailPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastChecked: Date;
  private readonly detector = new InvoiceDetector();

  constructor(
    private readonly graph: GraphClient,
    /** Getter instead of direct reference — window may be recreated */
    private readonly getWindow: () => BrowserWindow | null,
  ) {
    // On first poll fetch the last 24 h so we catch recent emails immediately
    this.lastChecked = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  // ─── Control ───────────────────────────────────────────────────────────────

  start(intervalMs = 5 * 60 * 1000): void {
    if (this.isRunning) return;
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

        const attachments = await this.graph.getAttachments(msg.id);
        detected.push(...this.detector.analyze(msg, attachments));
      }

      if (detected.length > 0) {
        win.webContents.send('outlook:invoicesDetected', detected);
      }

      win.webContents.send('outlook:pollComplete', {
        checkedAt: this.lastChecked.toISOString(),
        found: detected.length,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const w = this.getWindow();
      w?.webContents.send('outlook:pollError', message);
    }
  }
}
