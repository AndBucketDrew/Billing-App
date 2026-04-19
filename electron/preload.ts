import { contextBridge, ipcRenderer } from 'electron';
import type {
  Tour,
  Invoice,
  CompanySettings
} from '../src/app/core/models/domain.models';
import type { DetectedInvoice } from '../electron/invoice-detector/invoice-detector';
import type { OutlookSettings } from '../electron/ipc/outlook-ipc';

// Re-export so Angular-side code can import types without touching electron paths
export type { DetectedInvoice, OutlookSettings };

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

    // Push event subscriptions (main → renderer)
    on: (
      event: 'outlook:invoicesDetected' | 'outlook:pollComplete' | 'outlook:pollError',
      handler: (...args: any[]) => void,
    ) => void;
    off: (
      event: 'outlook:invoicesDetected' | 'outlook:pollComplete' | 'outlook:pollError',
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
      ipcRenderer.invoke('invoice:delete', id)
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

    // Validated allow-list of push event channels
    on: (event: string, handler: (...args: any[]) => void) => {
      const allowed = ['outlook:invoicesDetected', 'outlook:pollComplete', 'outlook:pollError'];
      if (allowed.includes(event)) {
        ipcRenderer.on(event, (_ipcEvent, ...args) => handler(...args));
      }
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      ipcRenderer.removeListener(event, handler);
    },
  }
} as ElectronAPI);

// Type declaration for TypeScript
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}