import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { ElectronAPI } from '../../../../electron/preload';

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

  /** Mock API for browser development */
  private createMockAPI(): ElectronAPI {
    return {
      tour: {
        getAll: async () => [],
        create: async (tour) => ({ ...tour, id: 'mock', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
        update: async () => null,
        delete: async () => false
      },
      invoice: {
        getAll: async () => [],
        getById: async () => null,
        create: async (inv) => ({ ...inv, id: 'mock', invoiceNumber: 'MOCK-001', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
        update: async () => null,
        delete: async () => false
      },
      settings: {
        get: async () => ({
          language: 'de',
          invoiceCounter: 1,
          companyName: '',
          companyAddress: '',
          city: '',
          country: '',
          vatNumber: '',
          logoPath: '',
          defaultVatPercentage: 13,
          bankName: '',
          accountHolder: '',
          iban: '',
          bic: '',
          legalForm: '',
          headquarters: '',
          courtRegistry: '',
          registrationNumber: '',
          invoiceFooterText: ''
        }),
        update: async (updates) => ({
          language: 'de',
          invoiceCounter: 1,
          companyName: '',
          companyAddress: '',
          city: '',
          country: '',
          vatNumber: '',
          logoPath: '',
          defaultVatPercentage: 13,
          bankName: '',
          accountHolder: '',
          iban: '',
          bic: '',
          legalForm: '',
          headquarters: '',
          courtRegistry: '',
          registrationNumber: '',
          invoiceFooterText: '',
          ...updates
        }),
        selectLogo: async () => null
      },
      pdf: {
        save: async () => null
      },
      excel: {
        save: async () => null
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
      }
    };
  }
}
