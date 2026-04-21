import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { ElectronAPI } from '../../../../electron/preload';
import { DEMO_TOURS, DEMO_INVOICES, DEMO_SETTINGS } from './demo-data';
import type { Tour, Invoice, CompanySettings } from '../models/domain.models';

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private electronAPI: ElectronAPI;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    if (this.isElectron()) {
      this.electronAPI = (window as any).electronAPI;
    } else {
      console.warn('Not running in Electron - IPC calls will use mock API');
      this.electronAPI = this.createMockAPI();
    }
  }

  /** Safely detect if running inside Electron renderer */
  isElectron(): boolean {
    // Only check window in browser environment
    if (!isPlatformBrowser(this.platformId)) {
      return false;
    }

    return !!((window as any).electronAPI);
  }

  get api(): ElectronAPI {
    return this.electronAPI;
  }

  /** localStorage-backed demo API — seeds Vienna tour data on first load */
  private createMockAPI(): ElectronAPI {
    const LS_TOURS    = 'demo_tours';
    const LS_INVOICES = 'demo_invoices';
    const LS_SETTINGS = 'demo_settings';
    const LS_VERSION  = 'demo_version';
    const DEMO_VERSION = '2';

    const load = <T>(key: string, seed: T): T => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return seed;
        const parsed = JSON.parse(raw);
        // treat empty arrays as missing so we always show demo data
        if (Array.isArray(parsed) && parsed.length === 0) return seed;
        return parsed;
      } catch {
        return seed;
      }
    };

    const save = (key: string, value: unknown): void => {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
    };

    const uid = (): string =>
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Reseed whenever the demo version changes (or on first visit)
    if (localStorage.getItem(LS_VERSION) !== DEMO_VERSION) {
      save(LS_TOURS,    DEMO_TOURS);
      save(LS_INVOICES, DEMO_INVOICES);
      save(LS_SETTINGS, DEMO_SETTINGS);
      localStorage.setItem(LS_VERSION, DEMO_VERSION);
    }

    return {
      tour: {
        getAll: async () => load<Tour[]>(LS_TOURS, DEMO_TOURS),
        create: async (tour) => {
          const now = new Date().toISOString();
          const created: Tour = { ...tour as any, id: uid(), createdAt: now, updatedAt: now };
          const tours = load<Tour[]>(LS_TOURS, DEMO_TOURS);
          tours.push(created);
          save(LS_TOURS, tours);
          return created;
        },
        update: async (id, updates) => {
          const tours = load<Tour[]>(LS_TOURS, DEMO_TOURS);
          const idx = tours.findIndex(t => t.id === id);
          if (idx === -1) return null;
          tours[idx] = { ...tours[idx], ...updates, updatedAt: new Date().toISOString() };
          save(LS_TOURS, tours);
          return tours[idx];
        },
        delete: async (id) => {
          const tours = load<Tour[]>(LS_TOURS, DEMO_TOURS);
          const next = tours.filter(t => t.id !== id);
          if (next.length === tours.length) return false;
          save(LS_TOURS, next);
          return true;
        },
      },
      invoice: {
        getAll: async () => load<Invoice[]>(LS_INVOICES, DEMO_INVOICES),
        getById: async (id) => {
          const invoices = load<Invoice[]>(LS_INVOICES, DEMO_INVOICES);
          return invoices.find(i => i.id === id) ?? null;
        },
        create: async (inv) => {
          const now = new Date().toISOString();
          const created: Invoice = { ...inv as any, id: uid(), createdAt: now, updatedAt: now };
          const invoices = load<Invoice[]>(LS_INVOICES, DEMO_INVOICES);
          invoices.push(created);
          save(LS_INVOICES, invoices);
          return created;
        },
        update: async (id, updates) => {
          const invoices = load<Invoice[]>(LS_INVOICES, DEMO_INVOICES);
          const idx = invoices.findIndex(i => i.id === id);
          if (idx === -1) return null;
          invoices[idx] = { ...invoices[idx], ...updates, updatedAt: new Date().toISOString() };
          save(LS_INVOICES, invoices);
          return invoices[idx];
        },
        delete: async (id) => {
          const invoices = load<Invoice[]>(LS_INVOICES, DEMO_INVOICES);
          const next = invoices.filter(i => i.id !== id);
          if (next.length === invoices.length) return false;
          save(LS_INVOICES, next);
          return true;
        },
      },
      settings: {
        get: async () => load<CompanySettings>(LS_SETTINGS, DEMO_SETTINGS),
        update: async (updates) => {
          const current = load<CompanySettings>(LS_SETTINGS, DEMO_SETTINGS);
          const updated = { ...current, ...updates };
          save(LS_SETTINGS, updated);
          return updated;
        },
        selectLogo: async () => null,
      },
      pdf: {
        save: async () => null,
      },
      excel: {
        save: async () => null,
      },
      outlook: {
        login:          async () => ({ success: false as const, error: 'Not in Electron' }),
        logout:         async () => ({ success: true as const }),
        getAccount:     async () => ({ success: true as const, account: null }),
        fetchEmails:    async () => ({ success: true as const, invoices: [] }),
        saveAttachment: async () => ({ success: false as const, error: 'Not in Electron' }),
        chooseFolder:   async () => ({ success: false as const, canceled: true }),
        startPolling:   async () => ({ success: true as const }),
        stopPolling:    async () => ({ success: true as const }),
        isPolling:      async () => ({ polling: false }),
        getSettings:    async () => ({ clientId: '', inboxFolder: '', pollIntervalMinutes: 5 }),
        saveSettings:   async (u: any) => ({ clientId: '', inboxFolder: '', pollIntervalMinutes: 5, ...u }),
        on:  () => {},
        off: () => {},
      },
    };
  }
}
