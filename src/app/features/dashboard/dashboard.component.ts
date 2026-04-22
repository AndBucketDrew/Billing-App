import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { combineLatest, Subscription } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TourService } from '../../core/services/tour.service';
import { InvoiceService } from '../../core/services/invoice.service';
import { ExcelExportService } from '../../core/services/excel-export.service';
import { Invoice } from '../../core/models/domain.models';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  standalone: false
})
export class DashboardComponent implements OnInit, OnDestroy {
  tourCount = 0;
  totalInvoices = 0;
  draftCount = 0;
  finalizedCount = 0;
  totalRevenue = 0;
  recentInvoices: Invoice[] = [];
  today = new Date();
  isExporting = false;

  private allInvoices: Invoice[] = [];
  private sub?: Subscription;

  constructor(
    private tourService: TourService,
    private invoiceService: InvoiceService,
    private excelExport: ExcelExportService,
    private router: Router,
    private snackBar: MatSnackBar,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.sub = combineLatest([
      this.tourService.tours$,
      this.invoiceService.invoices$
    ]).subscribe(([tours, invoices]) => {
      this.allInvoices = invoices;
      this.tourCount = tours.length;
      this.totalInvoices = invoices.length;
      this.draftCount = invoices.filter(i => i.status === 'draft').length;
      this.finalizedCount = invoices.filter(i => i.status === 'finalized').length;
      this.totalRevenue = invoices
        .reduce((sum, i) => sum + i.totalGross, 0);
      this.recentInvoices = [...invoices]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
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

  async exportYear(year: number): Promise<void> {
    const yearInvoices = this.allInvoices.filter(inv => {
      const yy = parseInt(inv.invoiceNumber?.substring(0, 2) ?? '', 10);
      return 2000 + yy === year;
    });
    this.isExporting = true;
    try {
      await this.excelExport.exportYearToExcel(yearInvoices, year);
      this.snackBar.open(
        `Exported ${yearInvoices.length} invoices for ${year}`,
        this.translate.instant('COMMON.CLOSE'),
        { duration: 3000 }
      );
    } catch (error: any) {
      if (!error?.message?.includes('cancelled')) {
        this.snackBar.open(
          this.translate.instant('MESSAGES.ERROR'),
          this.translate.instant('COMMON.CLOSE'),
          { duration: 3000, panelClass: 'snackbar-error' }
        );
      }
    } finally {
      this.isExporting = false;
    }
  }

  formatCurrency(value: number): string {
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value);
  }

  navigate(path: string): void {
    this.router.navigate([path]);
  }
}
