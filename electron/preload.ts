import { contextBridge, ipcRenderer } from 'electron';

// ─── Listener wrapper registry ────────────────────────────────────────────────
// ipcRenderer.on() wraps handlers in anonymous lambdas so the IPC event object
// is stripped before the renderer-side handler is called.  We must store the
// wrapper keyed by (event, original handler) so removeListener can find it.
const _wrappers = new Map<string, Map<Function, (...args: any[]) => void>>();

function _addWrapper(event: string, handler: Function, wrapper: (...args: any[]) => void): void {
  if (!_wrappers.has(event)) _wrappers.set(event, new Map());
  _wrappers.get(event)!.set(handler, wrapper);
}

function _removeWrapper(event: string, handler: Function): void {
  const wrapper = _wrappers.get(event)?.get(handler);
  if (wrapper) {
    ipcRenderer.removeListener(event, wrapper);
    _wrappers.get(event)!.delete(handler);
  }
}

import type {
  Tour,
  Invoice,
  CompanySettings
} from '../src/app/core/models/domain.models';
import type { DetectedInvoice } from '../electron/invoice-detector/invoice-detector';
// A5 FIX: import from the electron layer — preload must not depend on Angular source
import type { OutlookSettings, InvoiceReviewItem } from '../electron/ipc/outlook-ipc';

// Re-export so Angular-side code can import types without touching electron paths
export type { DetectedInvoice, OutlookSettings, InvoiceReviewItem };

// ─── Shared Outlook types exposed to renderer ─────────────────────────────────

export type OutlookAccount = { name: string; username: string };

export type IpcResult<T = undefined> =
  | ({ success: true } & (T extends undefined ? {} : { [K in keyof T]: T[K] }))
  | { success: false; error?: string; canceled?: boolean };

// ─── API surface ──────────────────────────────────────────────────────────────

// Define the API interface
export interface ElectronAPI {
  // Tour operations
  tour: {
    getAll: () => Promise<Tour[]>;
    create: (tour: Omit<Tour, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Tour>;
    update: (id: string, updates: Partial<Tour>) => Promise<Tour | null>;
    delete: (id: string) => Promise<boolean>;
  };

  // Invoice operations
  invoice: {
    getAll: () => Promise<Invoice[]>;
    getById: (id: string) => Promise<Invoice | null>;
    create: (invoice: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt'>) => Promise<Invoice>;
    update: (id: string, updates: Partial<Invoice>) => Promise<Invoice | null>;
    delete: (id: string) => Promise<boolean>;
    /** Atomically assigns an invoice number (from the counter) and sets status to 'finalized'. */
    finalize: (id: string) => Promise<Invoice | null>;
    /** Atomically creates a credit note AND marks the original invoice as 'storniert' in one write. */
    createCreditNote: (originalId: string, payload: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Invoice>;
  };

  // Settings operations
  settings: {
    get: () => Promise<CompanySettings>;
    update: (updates: Partial<CompanySettings>) => Promise<CompanySettings>;
    selectLogo: () => Promise<string | null>;
  };

  // PDF operations
  pdf: {
    save: (pdfBase64: string, filename: string) => Promise<string | null>;
  };

  // Excel operations
  excel: {
    save: (excelBase64: string, filename: string) => Promise<string | null>;
  };

  // Data integrity push events (main → renderer)
  data: {
    on:  (event: 'data:restoredFromBackup', handler: (filename: string) => void) => void;
    off: (event: 'data:restoredFromBackup', handler: (filename: string) => void) => void;
  };

  // ── Outlook / Microsoft Graph ───────────────────────────────────────────────
  outlook: {
    // Auth
    login: () => Promise<IpcResult<{ account: OutlookAccount }>>;
    logout: () => Promise<IpcResult>;
    getAccount: () => Promise<IpcResult<{ account: OutlookAccount | null }>>;

    // Email detection
    fetchEmails: () => Promise<IpcResult<{ invoices: DetectedInvoice[] }>>;

    // File save
    saveAttachment: (args: {
      messageId: string;
      attachmentId: string;
      filename: string;
      targetFolder: string;
    }) => Promise<IpcResult<{ filePath: string }>>;

    // Native folder picker
    chooseFolder: () => Promise<IpcResult<{ folderPath: string }>>;

    // Background polling
    startPolling: () => Promise<IpcResult>;
    stopPolling: () => Promise<IpcResult>;
    isPolling: () => Promise<{ polling: boolean }>;

    // Outlook-specific settings
    getSettings: () => Promise<OutlookSettings>;
    saveSettings: (updates: Partial<OutlookSettings>) => Promise<OutlookSettings>;

    // Review-queue persistence across restarts
    loadQueue: () => Promise<InvoiceReviewItem[]>;
    saveQueue: (items: InvoiceReviewItem[]) => Promise<void>;

    // Push event subscriptions (main → renderer)
    on: (
      event:
        | 'outlook:invoicesDetected'
        | 'outlook:pollComplete'
        | 'outlook:pollError'
        | 'outlook:autoSaved'
        | 'outlook:autoSaveError'
        | 'outlook:warning'
        | 'outlook:pollerStopped',  // A3: emitted by MailPoller.stop() for UI sync
      handler: (...args: any[]) => void,
    ) => void;
    off: (
      event:
        | 'outlook:invoicesDetected'
        | 'outlook:pollComplete'
        | 'outlook:pollError'
        | 'outlook:autoSaved'
        | 'outlook:autoSaveError'
        | 'outlook:warning'
        | 'outlook:pollerStopped',
      handler: (...args: any[]) => void,
    ) => void;
  };
}

// Expose protected methods that can be called from the renderer
contextBridge.exposeInMainWorld('electronAPI', {
  tour: {
    getAll: () => ipcRenderer.invoke('tour:getAll'),
    create: (tour: Omit<Tour, 'id' | 'createdAt' | 'updatedAt'>) => 
      ipcRenderer.invoke('tour:create', tour),
    update: (id: string, updates: Partial<Tour>) => 
      ipcRenderer.invoke('tour:update', id, updates),
    delete: (id: string) => 
      ipcRenderer.invoke('tour:delete', id)
  },

  invoice: {
    getAll: () => ipcRenderer.invoke('invoice:getAll'),
    getById: (id: string) => ipcRenderer.invoke('invoice:getById', id),
    create: (invoice: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt'>) =>
      ipcRenderer.invoke('invoice:create', invoice),
    update: (id: string, updates: Partial<Invoice>) =>
      ipcRenderer.invoke('invoice:update', id, updates),
    delete: (id: string) =>
      ipcRenderer.invoke('invoice:delete', id),
    finalize: (id: string) =>
      ipcRenderer.invoke('invoice:finalize', id),
    createCreditNote: (originalId: string, payload: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>) =>
      ipcRenderer.invoke('invoice:createCreditNote', originalId, payload),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (updates: Partial<CompanySettings>) => 
      ipcRenderer.invoke('settings:update', updates),
    selectLogo: () => 
      ipcRenderer.invoke('settings:selectLogo')
  },

  pdf: {
    save: (pdfBase64: string, filename: string) =>
      ipcRenderer.invoke('pdf:save', pdfBase64, filename)
  },

  excel: {
    save: (excelBase64: string, filename: string) =>
      ipcRenderer.invoke('excel:save', excelBase64, filename)
  },

  data: {
    on: (event: string, handler: (filename: string) => void) => {
      if (event === 'data:restoredFromBackup') {
        const wrapper = (_ipcEvent: Electron.IpcRendererEvent, filename: string) => handler(filename);
        _addWrapper(event, handler, wrapper);
        ipcRenderer.on(event, wrapper);
      }
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      _removeWrapper(event, handler);
    },
  },

  // ── Outlook ──────────────────────────────────────────────────────────────────
  outlook: {
    login: () => ipcRenderer.invoke('outlook:login'),
    logout: () => ipcRenderer.invoke('outlook:logout'),
    getAccount: () => ipcRenderer.invoke('outlook:getAccount'),

    fetchEmails: () => ipcRenderer.invoke('outlook:fetchEmails'),

    saveAttachment: (args: {
      messageId: string; attachmentId: string;
      filename: string; targetFolder: string;
    }) => ipcRenderer.invoke('outlook:saveAttachment', args),

    chooseFolder: () => ipcRenderer.invoke('outlook:chooseFolder'),

    startPolling: () => ipcRenderer.invoke('outlook:startPolling'),
    stopPolling: () => ipcRenderer.invoke('outlook:stopPolling'),
    isPolling: () => ipcRenderer.invoke('outlook:isPolling'),

    getSettings: () => ipcRenderer.invoke('outlook:getSettings'),
    saveSettings: (updates: Partial<OutlookSettings>) =>
      ipcRenderer.invoke('outlook:saveSettings', updates),

    loadQueue: () => ipcRenderer.invoke('outlook:loadQueue'),
    saveQueue: (items: InvoiceReviewItem[]) => ipcRenderer.invoke('outlook:saveQueue', items),

    // Validated allow-list of push event channels
    on: (event: string, handler: (...args: any[]) => void) => {
      const allowed = [
        'outlook:invoicesDetected',
        'outlook:pollComplete',
        'outlook:pollError',
        'outlook:autoSaved',
        'outlook:autoSaveError',
        'outlook:warning',
        'outlook:pollerStopped', // A3
      ];
      if (allowed.includes(event)) {
        const wrapper = (_ipcEvent: Electron.IpcRendererEvent, ...args: any[]) => handler(...args);
        _addWrapper(event, handler, wrapper);
        ipcRenderer.on(event, wrapper);
      }
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      _removeWrapper(event, handler);
    },
  }
} as ElectronAPI);

// Type declaration for TypeScript
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}