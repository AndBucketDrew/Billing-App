/**
 * registerOutlookIpcHandlers — registers all IPC channels for Outlook features.
 *
 * Call this once from main.ts after the app is ready:
 *
 *   registerOutlookIpcHandlers(app.getPath('userData'), OUTLOOK_CLIENT_ID, () => mainWindow);
 *
 * IPC channels exposed:
 *   outlook:login            → { success, account? }
 *   outlook:logout           → { success }
 *   outlook:getAccount       → { success, account? }
 *   outlook:fetchEmails      → { success, invoices? }
 *   outlook:saveAttachment   → { success, filePath? }
 *   outlook:chooseFolder     → { success, folderPath? }
 *   outlook:startPolling     → { success }
 *   outlook:stopPolling      → { success }
 *   outlook:getSettings      → OutlookSettings
 *   outlook:saveSettings     → OutlookSettings
 *
 * Push events (main → renderer):
 *   outlook:invoicesDetected  — DetectedInvoice[]
 *   outlook:pollComplete      — { checkedAt: string; found: number }
 *   outlook:pollError         — string
 */

import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { MsalAuthService } from '../auth/msal-auth';
import { GraphClient } from '../graph/graph-client';
import { MailPoller } from '../graph/mail-poller';
import { InvoiceDetector } from '../invoice-detector/invoice-detector';

// ─── Settings stored for Outlook feature ─────────────────────────────────────

export interface OutlookSettings {
  /**
   * Azure AD Application (client) ID.
   * Register at https://portal.azure.com → App Registrations.
   */
  clientId: string;
  /** Root folder where confirmed invoices are saved. */
  inboxFolder: string;
  /** Polling interval in minutes. */
  pollIntervalMinutes: number;
}

const DEFAULT_SETTINGS: OutlookSettings = {
  clientId: '',
  inboxFolder: path.join(app.getPath('documents'), 'Tour Billing', 'Inbox'),
  pollIntervalMinutes: 5,
};

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerOutlookIpcHandlers(
  userDataPath: string,
  getWindow: () => BrowserWindow | null,
): void {
  const settingsFile = path.join(userDataPath, 'outlook-settings.json');

  // ── Settings helpers ──────────────────────────────────────────────────────

  function readSettings(): OutlookSettings {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function writeSettings(s: OutlookSettings): OutlookSettings {
    fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
    return s;
  }

  // ── Service instances (lazy, recreated when clientId changes) ─────────────

  let auth: MsalAuthService | null = null;
  let graph: GraphClient | null = null;
  let poller: MailPoller | null = null;
  const detector = new InvoiceDetector();

  function getServices(): { auth: MsalAuthService; graph: GraphClient; poller: MailPoller } {
    const settings = readSettings();

    if (!settings.clientId) {
      throw new Error('Azure Client ID is not configured. Please set it in Outlook Settings.');
    }

    if (!auth) {
      auth = new MsalAuthService(userDataPath, settings.clientId);
      graph = new GraphClient(auth);
      poller = new MailPoller(graph, getWindow);
    }

    return { auth, graph: graph!, poller: poller! };
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  ipcMain.handle('outlook:getSettings', (): OutlookSettings => {
    return readSettings();
  });

  ipcMain.handle('outlook:saveSettings', (_, updates: Partial<OutlookSettings>): OutlookSettings => {
    const current = readSettings();
    const next = { ...current, ...updates };

    // If clientId changed, reset service instances so they pick up the new ID
    if (updates.clientId && updates.clientId !== current.clientId) {
      poller?.stop();
      auth = null;
      graph = null;
      poller = null;
    }

    return writeSettings(next);
  });

  // ─── Auth ─────────────────────────────────────────────────────────────────

  ipcMain.handle('outlook:login', async () => {
    try {
      const { auth: a } = getServices();
      const account = await a.login();
      return { success: true, account };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  ipcMain.handle('outlook:logout', async () => {
    try {
      poller?.stop();
      auth?.logout();
      auth = null;
      graph = null;
      poller = null;
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  ipcMain.handle('outlook:getAccount', async () => {
    try {
      const { auth: a } = getServices();
      const account = await a.getLoggedInAccount();
      return { success: true, account };
    } catch (e: unknown) {
      // If not configured yet just return null account rather than an error
      return { success: true, account: null };
    }
  });

  // ─── Email fetch ──────────────────────────────────────────────────────────

  ipcMain.handle('outlook:fetchEmails', async () => {
    try {
      const { graph: g } = getServices();
      const messages = await g.getRecentMessages(50);
      const all = [];

      for (const msg of messages) {
        if (!msg.hasAttachments) continue;
        const attachments = await g.getAttachments(msg.id);
        all.push(...detector.analyze(msg, attachments));
      }

      return { success: true, invoices: all };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  // ─── Save attachment ──────────────────────────────────────────────────────

  ipcMain.handle(
    'outlook:saveAttachment',
    async (
      _,
      {
        messageId,
        attachmentId,
        filename,
        targetFolder,
      }: {
        messageId: string;
        attachmentId: string;
        filename: string;
        targetFolder: string;
      },
    ) => {
      try {
        const { graph: g } = getServices();
        const buffer = await g.downloadAttachment(messageId, attachmentId);

        fs.mkdirSync(targetFolder, { recursive: true });

        // Strip characters that are invalid in Windows/macOS/Linux file names
        const safeName = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
        const filePath = path.join(targetFolder, safeName);

        // Avoid silent overwrite — add a numeric suffix if the file exists
        const finalPath = uniquePath(filePath);
        fs.writeFileSync(finalPath, buffer);

        return { success: true, filePath: finalPath };
      } catch (e: unknown) {
        return { success: false, error: toMessage(e) };
      }
    },
  );

  // ─── Folder picker ────────────────────────────────────────────────────────

  ipcMain.handle('outlook:chooseFolder', async () => {
    const win = getWindow();
    if (!win) return { success: false, error: 'No window' };

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Folder for Invoice',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, folderPath: result.filePaths[0] };
  });

  // ─── Polling control ──────────────────────────────────────────────────────

  ipcMain.handle('outlook:startPolling', async () => {
    try {
      const { poller: p } = getServices();
      const settings = readSettings();
      p.start(settings.pollIntervalMinutes * 60 * 1000);
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  ipcMain.handle('outlook:stopPolling', async () => {
    poller?.stop();
    return { success: true };
  });

  ipcMain.handle('outlook:isPolling', () => {
    return { polling: poller?.running ?? false };
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Returns a path that does not already exist by appending (1), (2), … */
function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;

  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let n = 1;

  while (fs.existsSync(`${base} (${n})${ext}`)) n++;
  return `${base} (${n})${ext}`;
}
