import type { Tour, Invoice, CompanySettings } from '../src/app/core/models/domain.models';
export interface ElectronAPI {
    tour: {
        getAll: () => Promise<Tour[]>;
        create: (tour: Omit<Tour, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Tour>;
        update: (id: string, updates: Partial<Tour>) => Promise<Tour | null>;
        delete: (id: string) => Promise<boolean>;
    };
    invoice: {
        getAll: () => Promise<Invoice[]>;
        getById: (id: string) => Promise<Invoice | null>;
        create: (invoice: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt'>) => Promise<Invoice>;
        update: (id: string, updates: Partial<Invoice>) => Promise<Invoice | null>;
        delete: (id: string) => Promise<boolean>;
    };
    settings: {
        get: () => Promise<CompanySettings>;
        update: (updates: Partial<CompanySettings>) => Promise<CompanySettings>;
        selectLogo: () => Promise<string | null>;
    };
    pdf: {
        save: (pdfBase64: string, filename: string) => Promise<string | null>;
    };
}
declare global {
    interface Window {
        electronAPI: ElectronAPI;
    }
}
//# sourceMappingURL=preload.d.ts.map