import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';
import { Invoice } from '../models/domain.models';

@Injectable({ providedIn: 'root' })
export class ExcelExportService {

  async exportYearToExcel(invoices: Invoice[], year: number): Promise<void> {
    const rows = invoices.map(inv => ({
      'Invoice Number': inv.invoiceNumber,
      'Invoice Date': inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString('de-DE') : '',
      'Tour Date': inv.tourDate ? new Date(inv.tourDate).toLocaleDateString('de-DE') : '',
      'Customer': inv.customerName,
      'Company': inv.companyName ?? '',
      'Payment Method': inv.paymentMethod ?? '',
      'Pax': inv.pax ?? '',
      'Guide': inv.guide ?? '',
      'Net (€)': inv.totalNet,
      'VAT (€)': inv.totalVat,
      'Gross (€)': inv.totalGross,
      'Status': inv.status,
    }));

    const ws = XLSX.utils.json_to_sheet(rows);

    // Column widths
    ws['!cols'] = [
      { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 28 },
      { wch: 16 }, { wch: 6 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${year}`);

    const buffer: ArrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const base64 = this.arrayBufferToBase64(buffer);
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
