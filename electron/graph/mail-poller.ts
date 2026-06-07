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
 * Duplicate-save protection uses two independent mechanisms:
 *   1. lastChecked timestamp — the poller only fetches emails newer than this.
 *   2. savedIds set — per-invoice record that survives timestamp resets
 *      (fresh install, state file deleted, crash before saveState completes).
 *      Both are persisted together in the state file on every successful poll.
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { IMailClient, MailAttachment } from '../imap/email-types';
import { InvoiceDetector, DetectedInvoice } from '../invoice-detector/invoice-detector';
import { isTnef, extractTnef, extractMapiAttachments } from '../imap/tnef-extractor';

const STATE_FILENAME = 'outlook-poll-state.json';

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.tiff': 'image/tiff',
    '.tif':  'image/tiff',
    '.doc':  'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] ?? 'application/octet-stream';
}
const FALLBACK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days on first run
// Keeps memory and disk footprint bounded; oldest entries are evicted first.
const MAX_SAVED_IDS = 2000;

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
  private savedIds = new Set<string>();
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
    this.lastChecked = this.loadState();
  }

  // --- Control ---------------------------------------------------------------

  /** Applies poller options without starting the interval timer. */
  applyOptions(options: PollerOptions): void {
    this.trustedSenders = options.trustedSenders ?? [];
    this.connectionType = options.connectionType ?? '';
    this.onAutoSave = options.onAutoSave;
  }

  start(intervalMs = 5 * 60 * 1000, options: PollerOptions = {}): void {
    if (this.isRunning) return;
    this.applyOptions(options);
    this.isRunning = true;

    // Fire immediately, then on each interval
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(silent = false): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
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

  resetAndRescan(since: Date): void {
    this.lastChecked = since;
    this.saveState();
    this.poll();
  }

  // --- Poll ------------------------------------------------------------------

  async poll(): Promise<void> {
    if (this.pollInProgress) return;
    this.pollInProgress = true;

    const win = this.getWindow();
    if (!win || win.isDestroyed()) {
      this.pollInProgress = false;
      return;
    }

    const since = this.lastChecked;
    this.lastChecked = new Date();

    try {
      const messages = await this.client.getRecentMessages(1000, since);
      const detected: DetectedInvoice[] = [];

      for (const msg of messages) {
        if (!msg.hasAttachments) continue;

        try {
          const raw = await this.client.getAttachments(msg.id);
          const attachments = await this.expandTnef(msg.id, raw);
          detected.push(...this.detector.analyze(msg, attachments, this.trustedSenders, this.connectionType));
        } catch (attachErr: unknown) {
          const errMsg = attachErr instanceof Error ? attachErr.message : String(attachErr);
          console.warn('[poll] attachment fetch failed for msg', msg.id, errMsg);
          // Fallback: score on subject/sender/body alone — an email confirmed to have
          // attachments (hasAttachments = true) may still qualify on subject/body keywords
          // alone (e.g. subject "invoice" + body preview = 35 pts → medium).
          const fallback = this.detector.analyze(msg, [], this.trustedSenders, this.connectionType);
          detected.push(...fallback);
          if (fallback.length === 0) {
            const w = this.getWindow();
            if (w && !w.isDestroyed()) {
              w.webContents.send('outlook:warning',
                `Could not read attachments for an email from ${msg.from.address} — ` +
                `"${msg.subject ?? '(no subject)'}". It may be a missed invoice. ` +
                `Error: ${errMsg}`);
            }
          }
        }
      }

      if (this.onAutoSave) {
        for (const inv of detected) {
          if (inv.confidence === 'high') {
            const key = inv.messageId + '::' + inv.attachmentId;
            if (this.savedIds.has(key)) continue;
            try {
              await this.onAutoSave(inv);
              this.savedIds.add(key);
              if (this.savedIds.size > MAX_SAVED_IDS) {
                const oldest = this.savedIds.values().next().value;
                if (oldest !== undefined) this.savedIds.delete(oldest);
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              if (!win.isDestroyed()) {
                win.webContents.send('outlook:autoSaveError', { invoice: inv, error: message });
              }
            }
          }
        }
      }

      this.saveState();

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
      this.lastChecked = since;
      const message = err instanceof Error ? err.message : String(err);
      const w = this.getWindow();
      w?.webContents.send('outlook:pollError', message);
    } finally {
      this.pollInProgress = false;
    }
  }

  /**
   * Expands any winmail.dat attachment in the list by downloading the blob and
   * extracting the real filenames inside. Each extracted file becomes a synthetic
   * MailAttachment that keeps the original TNEF attachment ID so that the
   * existing download + resolveTnef path in the IPC layer still works correctly.
   * If extraction fails or yields nothing, the original stub is passed through
   * unchanged so the detector's TNEF fallback can still fire.
   */
  private async expandTnef(messageId: string, attachments: MailAttachment[]): Promise<MailAttachment[]> {
    const result: MailAttachment[] = [];
    for (const att of attachments) {
      const isTnefAtt =
        att.contentType === 'application/ms-tnef' ||
        att.name.toLowerCase() === 'winmail.dat';

      if (!isTnefAtt) {
        result.push(att);
        continue;
      }

      try {
        const buf = await this.client.downloadAttachment(messageId, att.id);
        if (!isTnef(buf)) { result.push(att); continue; }

        const files = (() => {
          const classic = extractTnef(buf);
          return classic.length > 0 ? classic : extractMapiAttachments(buf);
        })();

        if (files.length === 0) { result.push(att); continue; }

        for (const f of files) {
          result.push({
            id: att.id,             // keep original ID — download still fetches the TNEF blob
            name: f.name,
            contentType: guessMime(f.name),
            size: f.data.length,
            isInline: false,
          });
        }
      } catch {
        result.push(att);           // download failed — let detector's TNEF fallback handle it
      }
    }
    return result;
  }

  // --- Persistence -----------------------------------------------------------

  private loadState(): Date {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf-8');
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed.savedIds)) {
        this.savedIds = new Set(
          parsed.savedIds.filter((id: unknown) => typeof id === 'string'),
        );
      }

      const d = new Date(parsed.lastChecked);
      if (!isNaN(d.getTime())) return d;
    } catch {
      // file absent or corrupt
    }
    return new Date(Date.now() - FALLBACK_LOOKBACK_MS);
  }

  private saveState(): void {
    try {
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({ lastChecked: this.lastChecked.toISOString(), savedIds: [...this.savedIds] }),
      );
    } catch {
      // non-fatal
    }
  }
}
