/**
 * S4 FIX: replaced unmaintained SheetJS (xlsx 0.18.5) with ExcelJS 4.x.
 * ExcelJS 4+ is actively maintained, has no known CVEs, and supports browser
 * environments without Node.js polyfills.
 */
import { Injectable } from '@angular/core';
import ExcelJS from 'exceljs';
import { Invoice } from '../models/domain.models';

@Injectable({ providedIn: 'root' })
export class ExcelExportService {

  /**
   * Sort invoices so:
   *  - ascending by base invoice number (strip trailing G and all non-digits)
   *  - credit notes (G) come immediately after the invoice they correct
   */
  private sortForExport(invoices: Invoice[]): Invoice[] {
    return [...invoices].sort((a, b) => {
      const baseA = (a.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const baseB = (b.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const numA = parseInt(baseA || '0', 10);
      const numB = parseInt(baseB || '0', 10);
      if (numA !== numB) return numA - numB;                          // ascending
      const isGA = (a.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      const isGB = (b.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      return isGA - isGB;                                             // regular → G
    });
  }

  async exportYearToExcel(invoices: Invoice[], year: number): Promise<void> {
    const sorted = this.sortForExport(invoices);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Tour Billing';
    wb.created = new Date();

    const ws = wb.addWorksheet(`${year}`);
    ws.columns = [
      { header: 'Invoice Number', key: 'invoiceNumber', width: 20 },
      { header: 'Invoice Date',   key: 'invoiceDate',   width: 14 },
      { header: 'Tour Date',      key: 'tourDate',      width: 14 },
      { header: 'Customer',       key: 'customer',      width: 28 },
      { header: 'Company',        key: 'company',       width: 28 },
      { header: 'Payment Method', key: 'paymentMethod', width: 16 },
      { header: 'Pax',            key: 'pax',           width: 6  },
      { header: 'Guide',          key: 'guide',         width: 16 },
      { header: 'Net (€)',        key: 'net',           width: 12 },
      { header: 'VAT (€)',        key: 'vat',           width: 12 },
      { header: 'Gross (€)',      key: 'gross',         width: 12 },
      { header: 'Status',         key: 'status',        width: 12 },
      { header: 'Type',           key: 'type',          width: 12 },
    ];

    for (const inv of sorted) {
      ws.addRow({
        invoiceNumber: inv.invoiceNumber,
        invoiceDate:   inv.invoiceDate   ? new Date(inv.invoiceDate).toLocaleDateString('de-DE')  : '',
        tourDate:      inv.tourDate      ? new Date(inv.tourDate).toLocaleDateString('de-DE')     : '',
        customer:      inv.customerName,
        company:       inv.companyName   ?? '',
        paymentMethod: inv.paymentMethod ?? '',
        pax:           inv.pax           ?? '',
        guide:         inv.guide         ?? '',
        net:           inv.totalNet,
        vat:           inv.totalVat,
        gross:         inv.totalGross,
        status:        inv.status,
        type:          inv.type === 'credit_note' ? 'Gutschrift' : 'Rechnung',
      });
    }

    const buffer = await wb.xlsx.writeBuffer();
    const base64 = this.arrayBufferToBase64(buffer as ArrayBuffer);
    const filename = `invoices-${year}.xlsx`;

    const saved = await (window as any).electronAPI.excel.save(base64, filename);
    if (!saved) throw new Error('Export cancelled or failed');
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
