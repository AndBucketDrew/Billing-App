import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { InvoiceService } from '../../core/services/invoice.service';
import { PdfGeneratorService } from '../../core/services/pdf-gen.service';
import { ExcelExportService } from '../../core/services/excel-export.service';
import { SettingsService } from '../../core/services/settings.service';
import { ElectronService } from '../../core/services/electron.service';
import { Invoice, CompanySettings } from '../../core/models/domain.models';
import { Observable } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-invoice-list',
  templateUrl: './invoice-list.component.html',
  styleUrls: ['./invoice-list.component.scss'],
  standalone: false,
})
export class InvoiceListComponent implements OnInit {
  invoices$: Observable<Invoice[]>;
  allInvoices: Invoice[] = [];
  displayedColumns: string[] = ['invoiceNumber', 'invoiceDate', 'customerName', 'totalGross', 'status', 'actions'];

  filterStatus: 'all' | 'draft' | 'finalized' = 'all';
  filterYear: number | null = null;
  searchQuery: string = '';
  isExporting = false;

  private logoCache = new Map<string, string | null>();

  constructor(
    private invoiceService: InvoiceService,
    private pdfService: PdfGeneratorService,
    private excelExportService: ExcelExportService,
    private settingsService: SettingsService,
    private electron: ElectronService,
    private router: Router,
    private snackBar: MatSnackBar,
    private translate: TranslateService
  ) {
    this.invoices$ = this.invoiceService.invoices$;
    this.invoices$.subscribe(invs => this.allInvoices = invs ?? []);
  }

  getAvailableYears(): number[] {
    const years = new Set<number>();
    for (const inv of this.allInvoices) {
      if (inv.invoiceNumber && inv.invoiceNumber.length >= 2) {
        const yy = parseInt(inv.invoiceNumber.substring(0, 2), 10);
        if (!isNaN(yy)) years.add(2000 + yy);
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }

  async exportYear(): Promise<void> {
    if (!this.filterYear) return;
    const yearInvoices = this.allInvoices.filter(inv => {
      const yy = parseInt(inv.invoiceNumber?.substring(0, 2) ?? '', 10);
      return 2000 + yy === this.filterYear;
    });
    this.isExporting = true;
    try {
      await this.excelExportService.exportYearToExcel(yearInvoices, this.filterYear);
      this.showMessage(`Exported ${yearInvoices.length} invoices for ${this.filterYear}`);
    } catch (error: any) {
      if (!error?.message?.includes('cancelled')) {
        this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      }
    } finally {
      this.isExporting = false;
    }
  }

  ngOnInit(): void { }

  createInvoice(): void {
    this.router.navigate(['/invoices/create']);
  }

  editInvoice(invoice: Invoice): void {
    if (invoice.status !== 'draft') {
      this.showMessage(this.translate.instant('INVOICE.STATUS_FINALIZED'), 'error');
      return;
    }
    this.router.navigate(['/invoices/edit', invoice.id]);
  }

  async deleteInvoice(invoice: Invoice): Promise<void> {
    if (!confirm(this.translate.instant('INVOICE.DELETE_CONFIRM'))) return;
    try {
      await this.invoiceService.deleteInvoice(invoice.id);
      this.showMessage(this.translate.instant('MESSAGES.DELETE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error deleting invoice:', error);
    }
  }

  async generatePDF(invoice: Invoice): Promise<void> {
    try {
      const settings = this.settingsService.getSettings();
      await this.pdfService.generateInvoicePDF(invoice, settings);
      this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error generating PDF:', error);
    }
  }

  async finalizeInvoice(invoice: Invoice): Promise<void> {
    if (!confirm(this.translate.instant('INVOICE.FINALIZE_CONFIRM'))) return;
    try {
      await this.invoiceService.finalizeInvoice(invoice.id);
      this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error finalizing invoice:', error);
    }
  }

  async togglePaid(invoice: Invoice): Promise<void> {
    const confirmKey = invoice.isPaid ? 'INVOICE.MARK_UNPAID_CONFIRM' : 'INVOICE.MARK_PAID_CONFIRM';
    if (!confirm(this.translate.instant(confirmKey))) return;
    try {
      await this.invoiceService.togglePaid(invoice);
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error toggling paid status:', error);
    }
  }

  async createCreditNote(invoice: Invoice): Promise<void> {
    const msg = this.translate.instant('INVOICE.CREATE_CREDIT_NOTE_CONFIRM', {
      invoiceNumber: invoice.invoiceNumber
    });
    if (!confirm(msg)) return;
    try {
      await this.invoiceService.createCreditNote(invoice);
      this.showMessage(this.translate.instant('INVOICE.CREDIT_NOTE_CREATED'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error creating credit note:', error);
    }
  }

  /**
   * Filter by status AND search query (invoice number or customer name)
   */
  getFilteredInvoices(invoices: Invoice[] | null): Invoice[] {
    if (!invoices) return [];

    let result = invoices;

    // Year filter
    if (this.filterYear !== null) {
      result = result.filter(inv => {
        const yy = parseInt(inv.invoiceNumber?.substring(0, 2) ?? '', 10);
        return 2000 + yy === this.filterYear;
      });
    }

    // Status filter
    if (this.filterStatus !== 'all') {
      result = result.filter(inv => inv.status === this.filterStatus);
    }

    // Search filter
    const q = this.searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(inv =>
        inv.invoiceNumber?.toLowerCase().includes(q) ||
        inv.customerName?.toLowerCase().includes(q)
      );
    }

    // Drafts (no number yet) always float to the top; then newest first;
    // credit notes (026G) always sit directly after their parent (026)
    result = [...result].sort((a, b) => {
      const aIsDraft = !a.invoiceNumber;
      const bIsDraft = !b.invoiceNumber;
      if (aIsDraft !== bIsDraft) return aIsDraft ? -1 : 1;             // drafts first

      const baseA = (a.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const baseB = (b.invoiceNumber ?? '').replace(/G$/i, '').replace(/\D/g, '');
      const numA = parseInt(baseA || '0', 10);
      const numB = parseInt(baseB || '0', 10);
      if (numA !== numB) return numB - numA;                            // descending
      const isGA = (a.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      const isGB = (b.invoiceNumber ?? '').toUpperCase().endsWith('G') ? 1 : 0;
      return isGA - isGB;                                               // regular before G
    });

    return result;
  }

  getStatusClass(status: string): string {
    if (status === 'finalized')  return 'status-finalized';
    if (status === 'storniert')  return 'status-storniert';
    return 'status-draft';
  }

  getStatusLabel(status: string): string {
    if (status === 'finalized')  return this.translate.instant('INVOICE.STATUS_FINALIZED');
    if (status === 'storniert')  return this.translate.instant('INVOICE.STATUS_STORNIERT');
    return this.translate.instant('INVOICE.STATUS_DRAFT');
  }

  isCreditNote(invoice: Invoice): boolean {
    return invoice.type === 'credit_note';
  }

  formatCurrency(value: number): string {
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value);
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return date.toLocaleDateString(locale);
  }

  async sendMail(invoice: Invoice): Promise<void> {
    const settings = this.settingsService.getSettings();
    const filename = `${invoice.invoiceNumber}.pdf`;

    let pdfBase64: string;
    try {
      pdfBase64 = await this.pdfService.getInvoicePdfBase64(invoice, settings);
    } catch {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      return;
    }

    let logoDataUrl: string | null = null;
    if (settings.logoPath) {
      if (!this.logoCache.has(settings.logoPath)) {
        let dataUrl: string | null = null;
        try {
          const resp = await fetch(settings.logoPath);
          if (resp.ok) {
            const blob = await resp.blob();
            dataUrl = await new Promise<string>((res, rej) => {
              const reader = new FileReader();
              reader.onload = () => res(reader.result as string);
              reader.onerror = rej;
              reader.readAsDataURL(blob);
            });
          }
        } catch { /* skip silently */ }
        this.logoCache.set(settings.logoPath, dataUrl);
      }
      logoDataUrl = this.logoCache.get(settings.logoPath) ?? null;
    }

    try {
      await this.electron.api.mail.openDraft({
        to: invoice.customerEmail ?? '',
        subject: this.buildEmailSubject(invoice, settings),
        body: this.buildEmailBody(invoice, settings, logoDataUrl),
        pdfBase64,
        filename,
      });
    } catch (err) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
    }
  }

  private buildEmailSubject(invoice: Invoice, settings: CompanySettings): string {
    const lang = invoice.language ?? 'en';
    const isCreditNote = invoice.type === 'credit_note';
    const customTemplate = lang === 'de' ? settings.emailSubjectDe : settings.emailSubjectEn;

    if (customTemplate) {
      return this.applyTemplateVars(customTemplate, invoice, settings);
    }

    if (lang === 'de') {
      return isCreditNote
        ? `Gutschrift Nr. ${invoice.invoiceNumber} – ${settings.companyName}`
        : `Rechnung Nr. ${invoice.invoiceNumber} – ${settings.companyName}`;
    }
    return isCreditNote
      ? `Credit Note No. ${invoice.invoiceNumber} – ${settings.companyName}`
      : `Invoice No. ${invoice.invoiceNumber} – ${settings.companyName}`;
  }

  private buildEmailBody(invoice: Invoice, settings: CompanySettings, logoDataUrl: string | null): string {
    const lang = invoice.language ?? 'en';
    const isCreditNote = invoice.type === 'credit_note';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const rawMessage = (lang === 'de' ? settings.emailBodyDe : settings.emailBodyEn)
      || this.getDefaultMessage(lang);
    const message = esc(this.applyTemplateVars(rawMessage, invoice, settings))
      .replace(/\n/g, '<br>');

    const L = lang === 'de' ? {
      docType:    isCreditNote ? 'Gutschrift' : 'Rechnung',
      number:     'Rechnungsnummer',
      date:       'Datum',
      payment:    'Zahlungsart',
      total:      'Gesamtbetrag',
      summary:    'Zusammenfassung',
      attached:   'Anhang',
      attachNote: `Die Datei &ldquo;${esc(invoice.invoiceNumber ?? '')}.pdf&rdquo; ist dieser E-Mail beigefügt.`,
      footer:     'Diese E-Mail wurde automatisch von Ihrem Abrechnungssystem generiert.',
    } : {
      docType:    isCreditNote ? 'Credit Note' : 'Invoice',
      number:     'Invoice Number',
      date:       'Date',
      payment:    'Payment Method',
      total:      'Total Amount',
      summary:    'Summary',
      attached:   'Attachment',
      attachNote: `The file &ldquo;${esc(invoice.invoiceNumber ?? '')}.pdf&rdquo; is attached to this email.`,
      footer:     'This email was automatically generated by your billing system.',
    };

    const co  = esc(settings.companyName);
    const inv = esc(invoice.invoiceNumber ?? '');
    const dt  = esc(this.formatDate(invoice.invoiceDate));
    const pm  = esc(invoice.paymentMethod ?? '–');
    const tot = esc(this.formatCurrency(invoice.totalGross));

    const initials = settings.companyName
      .split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase();

    const addrParts = [settings.companyAddress, settings.cityCountry].filter(Boolean).map(esc);
    const addrLine  = addrParts.length ? `<br><span style="color:#94a3b8;">${addrParts.join(' &middot; ')}</span>` : '';

    // Derive color palette from brand color
    const brand      = settings.brandColor ?? '#8a9a6a';
    const cDark2     = this.brandShade(brand, -22);  // darkest — gradient start, total hero
    const cDark1     = this.brandShade(brand, -12);  // dark — header gradient mid
    const cDark0     = this.brandShade(brand, -7);   // badge, avatar bg
    const cBorder    = this.brandShade(brand, +3);   // badge border
    const cLight     = this.brandShade(brand, +16);  // light text on dark bg
    const cPale      = this.brandShade(brand, +33);  // pale icon bg, dividers
    const cVeryPale  = this.brandShade(brand, +43);  // very light section bg
    const cNearWhite = this.brandShade(brand, +46);  // near-white footer / attachment body

    // Logo or monogram avatar above company name
    const logoHtml = logoDataUrl
      ? `<img src="${logoDataUrl}" alt="${co}" width="130" style="display:block;max-width:130px;max-height:64px;margin-bottom:20px;border:0;">`
      : `<table cellspacing="0" cellpadding="0" style="margin-bottom:20px;"><tr>
           <td width="54" height="54" bgcolor="${cDark0}" style="width:54px;height:54px;background:${cDark0};border:1px solid ${cBorder};border-radius:14px;text-align:center;vertical-align:middle;">
             <span style="font-size:21px;font-weight:800;color:#ffffff;letter-spacing:-.5px;">${initials}</span>
           </td>
         </tr></table>`;

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:${cNearWhite};font-family:'Segoe UI',Helvetica,Arial,sans-serif;" bgcolor="${cNearWhite}">

<table width="100%" cellspacing="0" cellpadding="0" bgcolor="${cNearWhite}" style="background:${cNearWhite};">
<tr><td align="center" style="padding:44px 16px 48px;">
<table width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.13);">

  <!-- ── HEADER ── -->
  <tr>
    <td bgcolor="${cDark1}" style="background:linear-gradient(135deg,${cDark2} 0%,${cDark1} 60%,${brand} 100%);padding:44px 48px 40px;">
      ${logoHtml}
      <p style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 16px 0;letter-spacing:-.3px;">${co}</p>
      <table cellspacing="0" cellpadding="0">
        <tr>
          <td bgcolor="${cDark0}" style="background:${cDark0};border:1px solid ${cBorder};border-radius:100px;padding:5px 16px;font-size:11px;font-weight:700;color:${cVeryPale};letter-spacing:1.6px;text-transform:uppercase;">${L.docType}</td>
          <td style="padding-left:14px;font-size:14px;color:${cLight};font-weight:500;">#${inv}</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- ── BODY ── -->
  <tr>
    <td bgcolor="#ffffff" style="background:#ffffff;padding:40px 48px 36px;">

      <!-- Message -->
      <p style="font-size:15px;color:#374151;line-height:1.9;margin:0 0 36px 0;">${message}</p>

      <!-- Divider -->
      <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
        <tr><td style="border-top:1px solid #f0f4f0;line-height:0;font-size:0;">&nbsp;</td></tr>
      </table>

      <!-- Summary heading -->
      <p style="font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:1.4px;text-transform:uppercase;margin:0 0 14px 0;">${L.summary}</p>

      <!-- Summary rows -->
      <table width="100%" cellspacing="0" cellpadding="0">
        <tr>
          <td style="padding:13px 0;border-bottom:1px solid #f3f4f0;font-size:13px;color:#6b7280;">${L.number}</td>
          <td style="padding:13px 0;border-bottom:1px solid #f3f4f0;font-size:13px;font-weight:600;color:#111827;text-align:right;">${inv}</td>
        </tr>
        <tr>
          <td style="padding:13px 0;border-bottom:1px solid #f3f4f0;font-size:13px;color:#6b7280;">${L.date}</td>
          <td style="padding:13px 0;border-bottom:1px solid #f3f4f0;font-size:13px;font-weight:500;color:#111827;text-align:right;">${dt}</td>
        </tr>
        <tr>
          <td style="padding:13px 0;font-size:13px;color:#6b7280;">${L.payment}</td>
          <td style="padding:13px 0;font-size:13px;font-weight:500;color:#111827;text-align:right;">${pm}</td>
        </tr>
      </table>

      <!-- Total hero -->
      <table width="100%" cellspacing="0" cellpadding="0" style="margin:22px 0 32px;border-radius:14px;overflow:hidden;">
        <tr>
          <td bgcolor="${cDark2}" style="background:linear-gradient(135deg,${this.brandShade(brand, -27)} 0%,${this.brandShade(brand, -17)} 100%);padding:22px 28px;font-size:14px;font-weight:600;color:${cLight};">${L.total}</td>
          <td bgcolor="${cDark2}" style="background:linear-gradient(135deg,${this.brandShade(brand, -27)} 0%,${this.brandShade(brand, -17)} 100%);padding:22px 28px;font-size:26px;font-weight:800;color:#ffffff;text-align:right;letter-spacing:-.5px;white-space:nowrap;">${tot}</td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- ── FOOTER ── -->
  <tr>
    <td bgcolor="${cNearWhite}" style="background:${cNearWhite};border-top:1px solid ${cPale};padding:22px 48px;">
      <p style="font-size:12px;color:#6b7280;font-weight:600;margin:0 0 2px 0;">${co}${addrLine}</p>
      <p style="font-size:11px;color:#94a3b8;margin:6px 0 0 0;">${L.footer}</p>
    </td>
  </tr>

</table>
</td></tr>
</table>

</body>
</html>`;
  }

  private getDefaultMessage(lang: string): string {
    if (lang === 'de') {
      return `Sehr geehrte/r {customer},\n\nanbei erhalten Sie Ihre {docType} Nr. {invoiceNumber} vom {date}.\n\nBei Fragen stehen wir Ihnen gerne zur Verfügung.\n\nMit freundlichen Grüßen\n{companyName}`;
    }
    return `Dear {customer},\n\nplease find enclosed your {docType} no. {invoiceNumber} dated {date}.\n\nShould you have any questions, please don't hesitate to contact us.\n\nKind regards,\n{companyName}`;
  }

  private applyTemplateVars(template: string, invoice: Invoice, settings: CompanySettings): string {
    const lang = invoice.language ?? 'en';
    const isCreditNote = invoice.type === 'credit_note';
    const salutation = invoice.salutation
      ? `${invoice.salutation} ${invoice.customerName}`
      : invoice.customerName;
    const docType = lang === 'de'
      ? (isCreditNote ? 'Gutschrift' : 'Rechnung')
      : (isCreditNote ? 'credit note' : 'invoice');

    return template
      .replace(/\{invoiceNumber\}/g, invoice.invoiceNumber ?? '')
      .replace(/\{date\}/g, this.formatDate(invoice.invoiceDate))
      .replace(/\{total\}/g, this.formatCurrency(invoice.totalGross))
      .replace(/\{customer\}/g, salutation)
      .replace(/\{companyName\}/g, settings.companyName)
      .replace(/\{paymentMethod\}/g, invoice.paymentMethod ?? '–')
      .replace(/\{filename\}/g, `${invoice.invoiceNumber}.pdf`)
      .replace(/\{docType\}/g, docType);
  }

  private showMessage(message: string, type: 'success' | 'error' = 'success'): void {
    this.snackBar.open(message, this.translate.instant('COMMON.CLOSE'), {
      duration: 3000,
      panelClass: type === 'error' ? 'snackbar-error' : 'snackbar-success'
    });
  }

  // ── Color utilities for brand-aware email template ──────────────────────────

  private hexToHsl(hex: string): [number, number, number] {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h * 360, s * 100, l * 100];
  }

  private hslToHex(h: number, s: number, l: number): string {
    h /= 360; s /= 100; l /= 100;
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r: number, g: number, b: number;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private brandShade(hex: string, lightnessOffset: number): string {
    const norm = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#8a9a6a';
    const [h, s, l] = this.hexToHsl(norm);
    return this.hslToHex(h, s, Math.min(97, Math.max(8, l + lightnessOffset)));
  }
}