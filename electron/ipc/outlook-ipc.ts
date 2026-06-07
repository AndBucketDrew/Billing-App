/**
 * registerOutlookIpcHandlers — registers all IPC channels for Outlook features.
 *
 * Supports two connection backends selectable via settings.connectionType:
 *   'msal' — Microsoft 365 / Exchange Online via Azure AD + Microsoft Graph API
 *   'imap' — Any mailbox via standard IMAP (plain username + password)
 *
 * Call this once from main.ts after the app is ready:
 *
 *   registerOutlookIpcHandlers(app.getPath('userData'), () => mainWindow);
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
 *   outlook:autoSaved         — { invoice, filePath }
 *   outlook:autoSaveError     — { invoice, error: string }
 *   outlook:warning           — string  (non-fatal advisory, e.g. insecure storage)
 *   outlook:pollerStopped     — (no payload) emitted by MailPoller.stop()
 */

import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { MsalAuthService } from '../auth/msal-auth';
import { GraphClient } from '../graph/graph-client';
import { MockMailClient } from '../graph/mock-graph-client';
import { ImapClient } from '../imap/imap-client';
import { MailPoller } from '../graph/mail-poller';
import { InvoiceDetector, DetectedInvoice } from '../invoice-detector/invoice-detector';
import { isTnef, extractTnef, extractMapiAttachments, extractRtfBody } from '../imap/tnef-extractor';
import type { IMailClient } from '../imap/email-types';

const EXTRACTABLE_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.doc', '.docx'];


/**
 * Resolves a downloaded attachment buffer through three stages:
 *  1. Classic TNEF (ATTACHTITLE / ATTACHDATA attributes)
 *  2. MAPI-encoded TNEF (PR_ATTACH_DATA_BIN — Exchange / Outlook 2007+)
 *  3. RTF body extraction (body-only winmail.dat with no file attachment)
 *
 * Returns the resolved buffer and filename, or null if nothing was extractable.
 */
function resolveTnef(
  buffer: Buffer,
  fallbackName: string,
  subject?: string,
): { buffer: Buffer; name: string } | null {
  if (!isTnef(buffer)) return null;

  // Stage 1 — classic TNEF attributes
  let files = extractTnef(buffer);

  // Stage 2 — MAPI property stream (newer Outlook/Exchange format)
  if (files.length === 0) files = extractMapiAttachments(buffer);

  if (files.length > 0) {
    const match = files.find(f =>
      EXTRACTABLE_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext)),
    );
    const chosen = match ?? files[0];
    return { buffer: chosen.data, name: chosen.name || fallbackName };
  }

  // Stage 3 — body-only winmail.dat: use the email subject as filename so the
  // saved RTF is human-readable instead of "winmail.rtf".
  const rtf = extractRtfBody(buffer);
  if (rtf) {
    const base = subject
      ? subject.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 80) || 'email-body'
      : fallbackName.replace(/\.dat$/i, '') || 'email-body';
    return { buffer: rtf, name: `${base}.rtf` };
  }

  return null;
}

// ─── Settings types ───────────────────────────────────────────────────────────

export type ConnectionType = 'msal' | 'imap' | 'mock';

export interface OutlookSettings {
  /** Which backend to use */
  connectionType: ConnectionType;

  // ── MSAL / Microsoft 365 ─────────────────────────────────────────────────
  /** Azure AD Application (client) ID. Register at portal.azure.com → App Registrations. */
  clientId: string;

  // ── IMAP ────────────────────────────────────────────────────────────────
  imapHost: string;
  imapPort: number;
  /** true = SSL/TLS on port 993 (recommended), false = STARTTLS on port 143 */
  imapTls: boolean;
  /**
   * When true, TLS certificate errors are silently ignored for this IMAP account.
   * Only enable for servers whose certificate CN/SAN does not match the hostname
   * (e.g. shared-hosting catch-all certs). Exposes the connection to MITM.
   */
  imapIgnoreCertErrors: boolean;
  imapUser: string;
  /**
   * Plaintext password — only used when saving.
   * When reading settings, this is always '' (password is stored encrypted on disk).
   */
  imapPassword: string;
  /** True when an encrypted password is saved on disk. Read-only. */
  hasStoredPassword: boolean;

  // ── Common ────────────────────────────────────────────────────────────────
  /** Root folder where confirmed invoices are saved. */
  inboxFolder: string;
  /** Polling interval in minutes. */
  pollIntervalMinutes: number;
  /** Exact sender email addresses that always score 100 (guaranteed high confidence). */
  trustedSenders: string[];
  /** When true, high-confidence invoices are saved automatically during polling. */
  autoDownloadHighConfidence: boolean;
}

// ─── Review-queue types (canonical definitions — re-exported via preload) ─────

export type InvoiceReviewStatus = 'pending' | 'confirmed' | 'rejected' | 'saving' | 'saved';

export interface InvoiceReviewItem {
  invoice: DetectedInvoice;
  status: InvoiceReviewStatus;
  /** Overridden by the user via the folder picker */
  targetFolder?: string;
  savedPath?: string;
  error?: string;
}

// ─── On-disk schema (extends settings with encrypted password field) ──────────

interface StoredSettings extends Omit<OutlookSettings, 'imapPassword' | 'hasStoredPassword'> {
  /** Base64-encoded encrypted password (via safeStorage). Never in the IPC interface. */
  imapPasswordEnc?: string;
  /**
   * S3: tracks HOW the password was stored so we can transparently upgrade to
   * safeStorage encryption the first time the keychain becomes available.
   *   'safeStorage' — encrypted via the OS keychain (secure)
   *   'base64'      — plain Base64 fallback (insecure, used when keychain unavailable)
   * Absent on settings files written before this field was introduced; treated as 'base64'.
   */
  imapPasswordEncMethod?: 'safeStorage' | 'base64';
}

const DEFAULT_SETTINGS: StoredSettings = {
  connectionType: 'msal' as ConnectionType,
  clientId: '',
  imapHost: '',
  imapPort: 993,
  imapTls: true,
  imapIgnoreCertErrors: false,
  imapUser: '',
  inboxFolder: path.join(app.getPath('documents'), 'Tour Billing', 'Inbox'),
  pollIntervalMinutes: 5,
  trustedSenders: [],
  autoDownloadHighConfidence: false,
};

/** Fields the renderer is allowed to supply — anything outside this list is ignored. */
const ALLOWED_SETTING_KEYS: Array<keyof OutlookSettings> = [
  'connectionType', 'clientId',
  'imapHost', 'imapPort', 'imapTls', 'imapIgnoreCertErrors',
  'imapUser', 'imapPassword',
  'inboxFolder', 'pollIntervalMinutes', 'trustedSenders', 'autoDownloadHighConfidence',
];

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerOutlookIpcHandlers(
  userDataPath: string,
  getWindow: () => BrowserWindow | null,
): void {
  const settingsFile = path.join(userDataPath, 'outlook-settings.json');

  // ── Settings helpers ──────────────────────────────────────────────────────

  /** In-memory cache — invalidated on every write to avoid redundant disk reads. */
  let settingsCache: StoredSettings | null = null;

  function readRaw(): StoredSettings {
    if (settingsCache) return settingsCache;
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      settingsCache = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      settingsCache = { ...DEFAULT_SETTINGS };
    }
    return settingsCache!;
  }

  /**
   * Atomic write: write to a temp file first, then rename over the target.
   * Rename is atomic on the same filesystem — a crash mid-write cannot
   * corrupt the previous settings file.
   */
  function writeRaw(s: StoredSettings): void {
    const json = JSON.stringify(s, null, 2);
    const tmp = `${settingsFile}.tmp`;
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, settingsFile);
    settingsCache = s;
  }

  /** Convert stored settings → IPC-safe settings (strips enc, adds hasStoredPassword). */
  function toPublic(raw: StoredSettings): OutlookSettings {
    return {
      connectionType: raw.connectionType,
      clientId: raw.clientId,
      imapHost: raw.imapHost,
      imapPort: raw.imapPort,
      imapTls: raw.imapTls,
      imapIgnoreCertErrors: raw.imapIgnoreCertErrors ?? false,
      imapUser: raw.imapUser,
      imapPassword: '',  // never expose plaintext over IPC
      hasStoredPassword: !!raw.imapPasswordEnc,
      inboxFolder: raw.inboxFolder,
      pollIntervalMinutes: raw.pollIntervalMinutes,
      trustedSenders: raw.trustedSenders,
      autoDownloadHighConfidence: raw.autoDownloadHighConfidence,
    };
  }

  /**
   * Returns the stored IMAP password.
   *
   * S3 — Transparent upgrade: if the password was stored as plain Base64 because
   * safeStorage was unavailable at save time, and safeStorage has since become
   * available (e.g. the user logged into their OS keychain), the password is
   * silently re-encrypted and the settings file is updated before returning.
   */
  function getStoredPassword(raw: StoredSettings): string {
    if (!raw.imapPasswordEnc) {
      throw new Error('IMAP password not configured. Please enter your password in Settings.');
    }

    const encMethod = raw.imapPasswordEncMethod ?? 'base64'; // pre-field files treated as base64

    // Upgrade path: plain-Base64 → safeStorage
    if (encMethod !== 'safeStorage' && safeStorage.isEncryptionAvailable()) {
      const plaintext = Buffer.from(raw.imapPasswordEnc, 'base64').toString('utf-8');
      writeRaw({
        ...raw,
        imapPasswordEnc: safeStorage.encryptString(plaintext).toString('base64'),
        imapPasswordEncMethod: 'safeStorage',
      });
      return plaintext;
    }

    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(raw.imapPasswordEnc, 'base64');
      return safeStorage.decryptString(buf);
    }
    // safeStorage was unavailable when the password was saved — it is stored as
    // plain Base64 (NOT encrypted).  The user was warned about this at save time.
    return Buffer.from(raw.imapPasswordEnc, 'base64').toString('utf-8');
  }

  // ── Service instances ─────────────────────────────────────────────────────

  let msalAuth: MsalAuthService | null = null;
  let mailClient: IMailClient | null = null;
  let poller: MailPoller | null = null;
  const detector = new InvoiceDetector(app.getLocale());

  /**
   * Returns the current mail client, auth service, and poller — creating them
   * on first call (or after resetServices).  Has side effects on first call.
   */
  function getOrCreateServices(): { client: IMailClient; auth: MsalAuthService | null } {
    const raw = readRaw();

    // ── Mock mode (S2: blocked in production builds) ──────────────────────────
    if (raw.connectionType === 'mock') {
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error('Mock connection mode is not available in production builds.');
      }
      if (!mailClient) {
        mailClient = new MockMailClient();
        poller = new MailPoller(mailClient, getWindow, userDataPath, detector);
      }
      return { client: mailClient!, auth: null };
    }

    // ── IMAP ─────────────────────────────────────────────────────────────────
    if (raw.connectionType === 'imap') {
      if (!raw.imapUser) {
        throw new Error('IMAP username not configured. Please fill in the IMAP settings.');
      }
      const password = getStoredPassword(raw);

      if (!mailClient) {
        mailClient = new ImapClient({
          host: raw.imapHost,
          port: raw.imapPort,
          secure: raw.imapTls,
          user: raw.imapUser,
          password,
          ignoreCertErrors: raw.imapIgnoreCertErrors ?? false,
        });
        poller = new MailPoller(mailClient, getWindow, userDataPath, detector);
      }
      return { client: mailClient!, auth: null };
    }

    // ── MSAL / Microsoft 365 ─────────────────────────────────────────────────
    if (!raw.clientId) {
      throw new Error('Azure Client ID is not configured. Please set it in Outlook Settings.');
    }
    if (!msalAuth) {
      msalAuth = new MsalAuthService(userDataPath, raw.clientId);
      mailClient = new GraphClient(msalAuth);
      poller = new MailPoller(mailClient, getWindow, userDataPath, detector);
    }
    return { client: mailClient!, auth: msalAuth };
  }

  function resetServices(): void {
    poller?.stop();
    msalAuth = null;
    mailClient = null;
    poller = null;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  ipcMain.handle('outlook:getSettings', (): OutlookSettings => {
    return toPublic(readRaw());
  });

  ipcMain.handle('outlook:saveSettings', (_, updates: Partial<OutlookSettings>): OutlookSettings => {
    // Guard against malformed renderer payloads
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return toPublic(readRaw());
    }

    const raw = readRaw();

    // Whitelist: only accept known setting keys — silently drop anything else
    const sanitized: Partial<OutlookSettings> = {};
    for (const key of ALLOWED_SETTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        (sanitized as any)[key] = (updates as any)[key];
      }
    }

    // Pull the password out before merging — it must NEVER reach the disk file
    const { imapPassword, hasStoredPassword: _hs, ...safeUpdates } = sanitized as any;
    const next: StoredSettings = { ...raw, ...safeUpdates };

    // Encrypt and store password if a new one was provided
    if (imapPassword && imapPassword !== '') {
      if (safeStorage.isEncryptionAvailable()) {
        next.imapPasswordEnc = safeStorage.encryptString(imapPassword).toString('base64');
        next.imapPasswordEncMethod = 'safeStorage'; // S3: record method for upgrade detection
      } else {
        // Fallback: base64 only — NOT encrypted. Warn the user explicitly.
        next.imapPasswordEnc = Buffer.from(imapPassword, 'utf-8').toString('base64');
        next.imapPasswordEncMethod = 'base64'; // S3: mark as unencrypted for future upgrade
        getWindow()?.webContents.send(
          'outlook:warning',
          'Secure credential storage is not available on this system. ' +
          'The IMAP password is stored as Base64 on disk and is not encrypted. ' +
          'Consider using Microsoft 365 (MSAL) for secure authentication.',
        );
      }
    }

    // A4: clamp imapPort to a valid TCP port range — HTML min/max are UI hints only.
    // next was already spread from safeUpdates above, so we must write directly to next
    // rather than back to sanitized (which is no longer consulted after this point).
    if ('imapPort' in sanitized) {
      const p = Number((sanitized as any).imapPort);
      next.imapPort = isNaN(p) ? 993 : Math.max(1, Math.min(65535, Math.round(p)));
    }

    // B1 FIX: compare against current value — connectionType being present in the
    // payload (which is always true when the component sends the full settings object)
    // must NOT be treated as a change unless the value actually differs.
    // Reset services when any connection-critical setting changes.
    // imapPort and imapTls are included because changing them requires a new ImapClient.
    const credChanged =
      (sanitized.connectionType !== undefined && sanitized.connectionType !== raw.connectionType) ||
      (sanitized.clientId  !== undefined && sanitized.clientId  !== raw.clientId)  ||
      (sanitized.imapHost  !== undefined && sanitized.imapHost  !== raw.imapHost)  ||
      (sanitized.imapPort  !== undefined && sanitized.imapPort  !== raw.imapPort)  ||
      (sanitized.imapTls   !== undefined && sanitized.imapTls   !== raw.imapTls)   ||
      (sanitized.imapUser  !== undefined && sanitized.imapUser  !== raw.imapUser)  ||
      (imapPassword !== undefined && imapPassword !== '');

    if (credChanged) resetServices();

    writeRaw(next);

    // Restart the poller so new trustedSenders / autoDownload changes take effect.
    // B_NEW_2: use stop(true) — the poller is immediately restarted so we must NOT
    // emit pollerStopped, which would desync isPolling in the UI.
    if (!credChanged && poller?.running && mailClient) {
      poller.stop(true);
      poller.start(clampIntervalMs(next.pollIntervalMinutes), {
        trustedSenders: next.trustedSenders,
        connectionType: next.connectionType,
        onAutoSave: next.autoDownloadHighConfidence
          ? makeAutoSaver(next, mailClient)
          : undefined,
      });
    }

    return toPublic(next);
  });

  // ─── Auth ─────────────────────────────────────────────────────────────────

  ipcMain.handle('outlook:login', async () => {
    try {
      const raw = readRaw();
      const { client, auth } = getOrCreateServices();

      // IMAP — test the connection
      if (raw.connectionType === 'imap') {
        await (client as ImapClient).testConnection();
        return { success: true, account: { username: raw.imapUser, name: raw.imapUser } };
      }

      // Mock
      if (raw.connectionType === 'mock') {
        return { success: true, account: { username: 'mock@example.com', name: 'Mock User' } };
      }

      // MSAL — interactive OAuth2 login (auth is guaranteed non-null here)
      if (!auth) throw new Error('Azure Client ID is not configured. Please set it in Outlook Settings.');
      const account = await auth.login();
      // Warn the user if the token cache cannot be persisted — they will need to
      // re-authenticate after every restart until safeStorage becomes available.
      if (!safeStorage.isEncryptionAvailable()) {
        getWindow()?.webContents.send(
          'outlook:warning',
          'Secure credential storage is not available on this system. ' +
          'Your Microsoft 365 session cannot be persisted — you will need to sign in again after each restart.',
        );
      }
      return { success: true, account };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  ipcMain.handle('outlook:logout', async () => {
    try {
      poller?.stop();
      if (msalAuth) await msalAuth.logout();
      resetServices();
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  ipcMain.handle('outlook:getAccount', async () => {
    try {
      const raw = readRaw();

      // IMAP — return account from settings if credentials are stored
      if (raw.connectionType === 'imap') {
        if (raw.imapUser && raw.imapPasswordEnc) {
          return { success: true, account: { username: raw.imapUser, name: raw.imapUser } };
        }
        return { success: true, account: null };
      }

      // Mock
      if (raw.connectionType === 'mock') {
        return { success: true, account: { username: 'mock@example.com', name: 'Mock User' } };
      }

      // MSAL — check cached token
      if (!raw.clientId) return { success: true, account: null };
      const { auth } = getOrCreateServices();
      if (!auth) return { success: true, account: null };
      const account = await auth.getLoggedInAccount();
      return { success: true, account };
    } catch (e: unknown) {
      // B6: log instead of silently swallowing — masks real bugs otherwise
      console.warn('[outlook:getAccount]', e instanceof Error ? e.message : String(e));
      return { success: true, account: null };
    }
  });

  // ─── Email fetch ──────────────────────────────────────────────────────────

  ipcMain.handle('outlook:fetchEmails', async () => {
    try {
      const { client } = getOrCreateServices();
      if (!poller) {
        poller = new MailPoller(client, getWindow, userDataPath, detector);
      }
      const settings = readRaw();
      // Apply current settings (trusted senders, auto-save) so the one-off poll
      // uses the same options the user configured, even if the poller isn't running.
      poller.applyOptions({
        trustedSenders: settings.trustedSenders,
        connectionType: settings.connectionType,
        onAutoSave: settings.autoDownloadHighConfidence
          ? makeAutoSaver(settings, client)
          : undefined,
      });
      // Fire-and-forget: results arrive via outlook:invoicesDetected + outlook:pollComplete
      // push events.  Returning immediately prevents the renderer from blocking on a
      // potentially long IMAP fetch (SEARCH + FETCH for hundreds of messages).
      void poller.poll();
      return { success: true };
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
        subject,
        targetFolder,
      }: {
        messageId: string;
        attachmentId: string;
        filename: string;
        subject?: string;
        targetFolder: string;
      },
    ) => {
      try {
        const { client } = getOrCreateServices();
        const settings = readRaw();

        // path.resolve('') returns CWD — reject before the traversal check can be bypassed.
        if (!settings.inboxFolder) {
          return { success: false, error: 'Inbox folder is not configured. Please set it in Outlook Settings.' };
        }

        // Prevent path traversal: targetFolder must be inside the configured inbox root
        const resolvedTarget = path.resolve(targetFolder);
        const resolvedRoot = path.resolve(settings.inboxFolder);
        if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
          return { success: false, error: 'Target folder is outside the configured inbox folder.' };
        }

        let buffer = await client.downloadAttachment(messageId, attachmentId);
        let resolvedFilename = filename;

        // TNEF (winmail.dat): Outlook Rich Text Format emails embed attachments
        // inside a single TNEF blob.  Extract the first processable file so the
        // user gets the actual PDF instead of the raw winmail.dat container.
        // When the poller's TNEF expansion already resolved the real filename
        // (e.g. "invoice_2026000056.pdf"), keep it — only fall back to the
        // extractor's name when we still have the raw container name.
        const resolved = resolveTnef(buffer, resolvedFilename, subject);
        if (resolved) {
          buffer = resolved.buffer;
          if (resolvedFilename.toLowerCase() === 'winmail.dat') {
            resolvedFilename = resolved.name;
          }
        }

        // Use the resolved path — consistent with the traversal check above
        fs.mkdirSync(resolvedTarget, { recursive: true });

        // Strip characters that are invalid in Windows/macOS/Linux file names
        const safeName = resolvedFilename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
        const filePath = path.join(resolvedTarget, safeName);

        // Re-validate after TNEF extraction — an embedded filename may contain dot-segments
        // (e.g. '..') that survive the sanitization regex and escape the inbox folder.
        if (!path.resolve(filePath).startsWith(resolvedRoot + path.sep)) {
          return { success: false, error: 'Attachment filename escapes the inbox folder.' };
        }

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

  function makeAutoSaver(settings: StoredSettings, clientInstance: IMailClient) {
    return async (inv: DetectedInvoice): Promise<void> => {
      // path.resolve('') returns CWD — reject before the traversal check can be bypassed.
      if (!settings.inboxFolder) {
        const win = getWindow();
        win?.webContents.send('outlook:autoSaveError', {
          invoice: inv,
          error: 'Auto-save skipped — inbox folder is not configured.',
        });
        return;
      }

      // Resolve both paths to prevent path-traversal via a crafted suggestedSubFolder
      const resolvedRoot   = path.resolve(settings.inboxFolder);
      const resolvedFolder = path.resolve(path.join(settings.inboxFolder, inv.suggestedSubFolder));

      if (
        resolvedFolder !== resolvedRoot &&
        !resolvedFolder.startsWith(resolvedRoot + path.sep)
      ) {
        const win = getWindow();
        win?.webContents.send('outlook:autoSaveError', {
          invoice: inv,
          error: 'Auto-save path is outside the configured inbox folder — skipped.',
        });
        return;
      }


      let buffer = await clientInstance.downloadAttachment(inv.messageId, inv.attachmentId);
      let attachName = inv.attachmentName;

      // Same logic as saveAttachment: keep the already-resolved filename when
      // the poller's TNEF expansion already gave us the real name.
      const resolved = resolveTnef(buffer, attachName, inv.subject);
      if (resolved) {
        buffer = resolved.buffer;
        if (attachName.toLowerCase() === 'winmail.dat') attachName = resolved.name;
      }

      fs.mkdirSync(resolvedFolder, { recursive: true });
      const safeName     = attachName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
      const candidatePath = path.join(resolvedFolder, safeName);

      // Re-validate after TNEF extraction — embedded filename may contain dot-segments.
      if (!path.resolve(candidatePath).startsWith(resolvedRoot + path.sep)) {
        const win = getWindow();
        win?.webContents.send('outlook:autoSaveError', { invoice: inv, error: 'Attachment filename escapes the inbox folder.' });
        return;
      }

      const finalPath = uniquePath(candidatePath);
      fs.writeFileSync(finalPath, buffer);
      getWindow()?.webContents.send('outlook:autoSaved', { invoice: inv, filePath: finalPath });
    };
  }

  ipcMain.handle('outlook:startPolling', async () => {
    try {
      const { client } = getOrCreateServices();
      if (!poller) poller = new MailPoller(client, getWindow, userDataPath, detector);
      const settings = readRaw();
      poller.start(clampIntervalMs(settings.pollIntervalMinutes), {
        trustedSenders: settings.trustedSenders,
        connectionType: settings.connectionType,
        onAutoSave: settings.autoDownloadHighConfidence
          ? makeAutoSaver(settings, client)
          : undefined,
      });
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  ipcMain.handle('outlook:stopPolling', async () => {
    poller?.stop();
    return { success: true };
  });

  ipcMain.handle('outlook:resetScan', (_, lookbackDays: number = 7) => {
    try {
      const days = Math.max(1, Math.min(365, Number(lookbackDays) || 7));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Write the state file directly — this works regardless of whether the poller
      // is running and avoids the race condition where an in-flight poll overwrites
      // a lastChecked that was set via the poller instance's in-memory state.
      const stateFile = path.join(userDataPath, 'outlook-poll-state.json');
      // Preserve savedIds so the rescan doesn't re-auto-save invoices already saved previously.
      let existingSavedIds: string[] = [];
      try {
        const existing = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        if (Array.isArray(existing.savedIds)) existingSavedIds = existing.savedIds;
      } catch {}
      fs.writeFileSync(stateFile, JSON.stringify({ lastChecked: since.toISOString(), savedIds: existingSavedIds }));

      // Always recreate the poller so its in-memory lastChecked reflects the new
      // state file value — even when the interval timer isn't running.
      // Without this, a subsequent "Fetch Now" would use the stale in-memory date
      // and silently skip emails that arrived before the old lastChecked.
      if (mailClient) {
        const wasRunning = poller?.running ?? false;
        if (wasRunning) poller!.stop(true);

        const settings = readRaw();
        poller = new MailPoller(mailClient, getWindow, userDataPath, detector);
        const opts = {
          trustedSenders: settings.trustedSenders,
          connectionType: settings.connectionType,
          onAutoSave: settings.autoDownloadHighConfidence
            ? makeAutoSaver(settings, mailClient)
            : undefined,
        };

        if (wasRunning) {
          // Resume the interval and fire immediately
          poller.start(clampIntervalMs(settings.pollIntervalMinutes), opts);
        } else {
          // Not polling — apply options and fire one immediate scan so the user
          // sees results without having to click "Fetch Now" separately.
          poller.applyOptions(opts);
          void poller.poll();
        }
      }

      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: toMessage(e) };
    }
  });

  ipcMain.handle('outlook:isPolling', () => {
    return { polling: poller?.running ?? false };
  });

  // ─── Review-queue persistence ─────────────────────────────────────────────

  const queueFile = path.join(userDataPath, 'outlook-review-queue.json');

  ipcMain.handle('outlook:loadQueue', (): any[] => {
    try {
      const raw = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
      if (!Array.isArray(raw)) return [];
      // Keep only well-formed items — silently drop anything malformed
      const VALID_STATUSES = new Set<InvoiceReviewStatus>(['pending', 'confirmed', 'rejected', 'saving', 'saved']);
      return raw
        .filter((item: any) =>
          item !== null &&
          typeof item === 'object' &&
          VALID_STATUSES.has(item.status) &&
          typeof item.invoice === 'object' &&
          item.invoice !== null &&
          typeof item.invoice.messageId === 'string' &&
          typeof item.invoice.attachmentId === 'string',
        )
        .map((item: any) => ({
          ...item,
          // Items interrupted mid-save revert to pending so the user can retry
          status: item.status === 'saving' ? 'pending' : item.status,
        }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('outlook:saveQueue', (_, items: unknown): void => {
    // Guard: only accept a plain array from the renderer
    if (!Array.isArray(items)) return;
    try {
      // Sanitise before writing — apply the same shape validation as loadQueue
      // so a corrupted or malicious renderer payload can't write arbitrary data.
      const VALID_STATUSES = new Set<InvoiceReviewStatus>(['pending', 'confirmed', 'rejected', 'saving', 'saved']);
      const sanitized = items.filter((item: any) =>
        item !== null &&
        typeof item === 'object' &&
        VALID_STATUSES.has(item.status) &&
        typeof item.invoice === 'object' &&
        item.invoice !== null &&
        typeof item.invoice.messageId === 'string' &&
        typeof item.invoice.attachmentId === 'string',
      );
      const tmp = `${queueFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2), 'utf-8');
      fs.renameSync(tmp, queueFile);
    } catch {
      // Non-fatal: worst case the queue is lost on next restart
    }
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Clamps poll interval to 1–60 minutes and converts to milliseconds. */
function clampIntervalMs(minutes: number | undefined): number {
  return Math.max(1, Math.min(60, minutes ?? 5)) * 60 * 1000;
}

/**
 * Returns a path guaranteed not to exist at the moment of return by using
 * exclusive-open (O_EXCL) semantics: the check and the file creation are one
 * atomic OS operation, which eliminates the TOCTOU race between existsSync and
 * the subsequent writeFileSync.  The empty placeholder file is created here
 * and the caller must overwrite it (writeFileSync without the 'x' flag is fine
 * since it already exists at that point).
 */
function uniquePath(filePath: string): string {
  const ext  = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  const MAX_SUFFIX = 9_999; // B5: prevent unbounded looping in pathological cases

  for (let n = 0; n <= MAX_SUFFIX; n++) {
    const candidate = n === 0 ? filePath : `${base} (${n})${ext}`;
    try {
      // 'wx' = write + exclusive-create; throws EEXIST if the file is already there
      const fd = fs.openSync(candidate, 'wx');
      fs.closeSync(fd);
      return candidate;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // File exists — try the next suffix
    }
  }
  throw new Error(
    `Cannot create a unique filename for "${path.basename(filePath)}" — ` +
    `${MAX_SUFFIX} duplicates already exist in the target folder.`,
  );
}
