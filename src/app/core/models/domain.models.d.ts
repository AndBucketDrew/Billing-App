export interface Tour {
    id: string;
    name: string;
    description: string;
    basePriceNet: number;
    vatPercentage: VatRate;
    createdAt: string;
    updatedAt: string;
}
export type VatRate = 0 | 10 | 13 | 20;
export interface InvoiceLineItem {
    id: string;
    tourId?: string;
    description: string;
    quantity: number;
    unitPriceNet: number;
    vatPercentage: VatRate;
    lineTotalNet: number;
    lineTotalVat: number;
    lineTotalGross: number;
    sortOrder: number;
}
export interface VatBreakdownItem {
    vatPercentage: VatRate;
    netTotal: number;
    vatAmount: number;
    grossTotal: number;
}
export interface Invoice {
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    customerName: string;
    customerAddress: string;
    language: 'de' | 'en';
    status: 'draft' | 'finalized';
    lineItems: InvoiceLineItem[];
    vatBreakdown: VatBreakdownItem[];
    totalNet: number;
    totalVat: number;
    totalGross: number;
    createdAt: string;
    updatedAt: string;
}
export interface CompanySettings {
    language: 'de' | 'en';
    companyName: string;
    companyAddress: string;
    vatNumber: string;
    logoPath?: string;
    defaultVatPercentage: VatRate;
}
export interface ToursData {
    tours: Tour[];
}
export interface InvoicesData {
    lastInvoiceNumber: number;
    invoices: Invoice[];
}
export interface VatLabelConfig {
    rate: VatRate;
    labelKey: string;
}
export declare const VAT_RATES: VatLabelConfig[];
//# sourceMappingURL=domain.models.d.ts.map