import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { combineLatest, Subscription } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TourService } from '../../core/services/tour.service';
import { InvoiceService } from '../../core/services/invoice.service';
import { ExcelExportService } from '../../core/services/excel-export.service';
import { Invoice } from '../../core/models/domain.models';
import { formatCurrencyEUR } from '../../core/utils/format.util';
import { TranslateService } from '@ngx-translate/core';

interface KpiCard {
  variant: 'revenue' | 'outstanding' | 'paid' | 'drafts';
  labelKey: string;
  icon: string;
  value: string;
  trend: number | null;   // % change vs last month, null when not comparable
  spark: string;          // SVG polyline points
  sparkArea: string;      // SVG polygon points (filled area)
}

interface MonthBucket {
  /** Short localized month label, e.g. "Jan" */
  label: string;
  net: number;
  vat: number;
  gross: number;
  paidGross: number;
  unpaidGross: number;
  draftCount: number;
}

interface BarDatum {
  label: string;
  gross: number;
  netPct: number;   // height % of tallest bar
  vatPct: number;
}

interface DonutSegment {
  labelKey: string;
  count: number;
  pct: number;            // 0..100
  color: string;
  dashArray: string;
  dashOffset: number;
}

const SPARK_W = 100;
const SPARK_H = 30;
const DONUT_R = 54;
const DONUT_C = 2 * Math.PI * DONUT_R;

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  standalone: false
})
export class DashboardComponent implements OnInit, OnDestroy {
  totalInvoices = 0;
  recentInvoices: Invoice[] = [];
  today = new Date();
  isExporting = false;

  kpis: KpiCard[] = [];
  bars: BarDatum[] = [];
  donut: DonutSegment[] = [];
  donutTotal = 0;
  hasData = false;

  // Exposed for the template's <svg> geometry
  readonly donutR = DONUT_R;
  readonly donutC = DONUT_C;

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
    ]).subscribe(([_tours, invoices]) => {
      this.allInvoices = invoices;
      this.totalInvoices = invoices.length;
      this.hasData = invoices.length > 0;
      this.recentInvoices = [...invoices]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);
      this.rebuild();
    });

    // Recompute labels/formatting when the language changes
    this.sub.add(this.translate.onLangChange.subscribe(() => this.rebuild()));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  // ─── Aggregation ──────────────────────────────────────────────────────────

  private rebuild(): void {
    const finalized = this.allInvoices.filter(i => i.status === 'finalized');
    const drafts = this.allInvoices.filter(i => i.status === 'draft');
    const cancelled = this.allInvoices.filter(i => i.status === 'storniert');
    const paid = finalized.filter(i => i.isPaid === true);
    const unpaid = finalized.filter(i => i.isPaid !== true);

    const totalRevenue = sum(finalized, i => i.totalGross);
    const outstanding = sum(unpaid, i => i.totalGross);
    const paidTotal = sum(paid, i => i.totalGross);

    const months = this.buildMonthlyBuckets(12);

    this.kpis = [
      {
        variant: 'revenue',
        labelKey: 'DASHBOARD.REVENUE',
        icon: 'payments',
        value: this.formatCurrency(totalRevenue),
        trend: monthOverMonth(months, m => m.gross),
        ...this.sparkOf(months.map(m => m.gross))
      },
      {
        variant: 'outstanding',
        labelKey: 'DASHBOARD.OUTSTANDING',
        icon: 'schedule',
        value: this.formatCurrency(outstanding),
        trend: monthOverMonth(months, m => m.unpaidGross),
        ...this.sparkOf(months.map(m => m.unpaidGross))
      },
      {
        variant: 'paid',
        labelKey: 'DASHBOARD.PAID',
        icon: 'check_circle',
        value: this.formatCurrency(paidTotal),
        trend: monthOverMonth(months, m => m.paidGross),
        ...this.sparkOf(months.map(m => m.paidGross))
      }
    ];

    this.bars = this.buildBars(months);
    this.buildDonut(paid.length, unpaid.length, drafts.length, cancelled.length);
  }

  /** Last `count` calendar months (oldest → newest) bucketed from invoice dates. */
  private buildMonthlyBuckets(count: number): MonthBucket[] {
    const locale = this.localeId();
    const now = new Date();
    const buckets: MonthBucket[] = [];
    const index = new Map<string, MonthBucket>();

    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const bucket: MonthBucket = {
        label: d.toLocaleDateString(locale, { month: 'short' }),
        net: 0, vat: 0, gross: 0, paidGross: 0, unpaidGross: 0, draftCount: 0
      };
      buckets.push(bucket);
      index.set(monthKey(d), bucket);
    }

    for (const inv of this.allInvoices) {
      const d = new Date(inv.invoiceDate || inv.createdAt);
      if (isNaN(d.getTime())) continue;
      const bucket = index.get(monthKey(d));
      if (!bucket) continue;

      if (inv.status === 'draft') {
        bucket.draftCount++;
        continue;
      }
      if (inv.status !== 'finalized') continue;

      bucket.net += inv.totalNet;
      bucket.vat += inv.totalVat;
      bucket.gross += inv.totalGross;
      if (inv.isPaid === true) bucket.paidGross += inv.totalGross;
      else bucket.unpaidGross += inv.totalGross;
    }

    return buckets;
  }

  private buildBars(months: MonthBucket[]): BarDatum[] {
    const max = Math.max(1, ...months.map(m => m.gross));
    return months.map(m => ({
      label: m.label,
      gross: m.gross,
      netPct: (m.net / max) * 100,
      vatPct: (m.vat / max) * 100
    }));
  }

  private buildDonut(paid: number, unpaid: number, drafts: number, cancelled: number): void {
    const raw = [
      { labelKey: 'DASHBOARD.STATUS_PAID', count: paid, color: '#1a7f37' },
      { labelKey: 'DASHBOARD.OUTSTANDING', count: unpaid, color: '#0969da' },
      { labelKey: 'DASHBOARD.DRAFTS', count: drafts, color: '#9a6700' },
      { labelKey: 'DASHBOARD.STATUS_CANCELLED', count: cancelled, color: '#d1242f' }
    ];
    const total = raw.reduce((s, r) => s + r.count, 0);
    this.donutTotal = total;

    let cumulative = 0;
    this.donut = raw.map(r => {
      const pct = total > 0 ? (r.count / total) * 100 : 0;
      const len = (pct / 100) * DONUT_C;
      const seg: DonutSegment = {
        labelKey: r.labelKey,
        count: r.count,
        pct,
        color: r.color,
        dashArray: `${len} ${DONUT_C - len}`,
        dashOffset: -((cumulative / 100) * DONUT_C)
      };
      cumulative += pct;
      return seg;
    });
  }

  /** Builds a smooth (curved) SVG path + filled-area path for a sparkline series. */
  private sparkOf(values: number[]): { spark: string; sparkArea: string } {
    if (values.length === 0) return { spark: '', sparkArea: '' };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const pad = 4;
    const usableH = SPARK_H - pad * 2;
    const step = values.length > 1 ? SPARK_W / (values.length - 1) : 0;

    const pts: Pt[] = values.map((v, i) => ({
      x: round(i * step),
      y: round(SPARK_H - pad - ((v - min) / range) * usableH)
    }));

    const spark = smoothPath(pts);
    const sparkArea = `${spark} L ${SPARK_W},${SPARK_H} L 0,${SPARK_H} Z`;
    return { spark, sparkArea };
  }

  // ─── Excel export ─────────────────────────────────────────────────────────

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

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private localeId(): string {
    return this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
  }

  formatCurrency(value: number): string {
    return formatCurrencyEUR(value, this.translate.currentLang);
  }

  navigate(path: string): void {
    this.router.navigate([path]);
  }

  navigateToInvoice(invoice: Invoice): void {
    this.router.navigate(['/invoices/edit', invoice.id]);
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + (pick(item) || 0), 0);
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Pt { x: number; y: number; }

/** Catmull-Rom spline through the points, emitted as smooth cubic béziers. */
function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`;

  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = round(p1.x + (p2.x - p0.x) / 6);
    const cp1y = round(p1.y + (p2.y - p0.y) / 6);
    const cp2x = round(p2.x - (p3.x - p1.x) / 6);
    const cp2y = round(p2.y - (p3.y - p1.y) / 6);
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/** % change of the most recent bucket vs the previous one; null when not comparable. */
function monthOverMonth(months: MonthBucket[], pick: (m: MonthBucket) => number): number | null {
  if (months.length < 2) return null;
  const current = pick(months[months.length - 1]);
  const previous = pick(months[months.length - 2]);
  if (previous === 0) return current === 0 ? null : 100;
  return ((current - previous) / previous) * 100;
}
