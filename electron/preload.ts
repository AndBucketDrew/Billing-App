import { contextBridge, ipcRenderer } from 'electron';
import type { 
  Tour, 
  Invoice, 
  CompanySettings 
} from '../src/app/core/models/domain.models';

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
  }
} as ElectronAPI);

// Type declaration for TypeScript
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}