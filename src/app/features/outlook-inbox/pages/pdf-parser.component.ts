import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { OutlookInboxStore } from '../outlook-inbox.store';
import { InvoiceReviewItem } from '../../../core/models/outlook.models';

type ParserFilter = 'review' | 'confirmed' | 'ignored' | 'all';

/**
 * PDF Parser page — "Invoices to Pay": payee/amount fields auto-extracted from
 * each saved PDF, a side-by-side source-document preview, per-invoice confirmation
 * and Excel export. Reads all state from the shared OutlookInboxStore.
 *
 * View-only concerns (the to-review/confirmed filter and which confirmed rows are
 * expanded) live here as local signals rather than in the shared store.
 */
@Component({
  selector: 'app-pdf-parser',
  templateUrl: './pdf-parser.component.html',
  styleUrls: ['./pdf-parser.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PdfParserComponent {
  /** Default view: invoices still awaiting review; confirmed ones are tucked away. */
  readonly filter = signal<ParserFilter>('review');

  /** trackBy keys of confirmed rows the user has manually expanded. */
  private readonly expandedKeys = signal(new Set<string>());

  readonly reviewCount = computed(() => this.store.activeParsedItems().filter(i => !i.reviewConfirmed).length);
  readonly confirmedCount = computed(() => this.store.activeParsedItems().filter(i => i.reviewConfirmed).length);
  readonly ignoredCount = computed(() => this.store.ignoredItems().length);
  /** Count for the "All" chip — every parsed invoice except the ignored ones. */
  readonly activeCount = computed(() => this.store.activeParsedItems().length);

  /** The parsed items shown for the active filter. */
  readonly visibleItems = computed<InvoiceReviewItem[]>(() => {
    const active = this.store.activeParsedItems();
    switch (this.filter()) {
      case 'review':    return active.filter(i => !i.reviewConfirmed);
      case 'confirmed': return active.filter(i => i.reviewConfirmed);
      case 'ignored':   return this.store.ignoredItems();
      default:          return active;
    }
  });

  constructor(readonly store: OutlookInboxStore) {}

  setFilter(filter: ParserFilter): void {
    this.filter.set(filter);
  }

  /**
   * Confirmed rows render collapsed (compact) unless the user expands them. A row with
   * unsaved edits stays expanded so the "Confirm changes" action remains reachable.
   */
  isCollapsed(item: InvoiceReviewItem): boolean {
    if (this.store.isDirty(item)) return false;
    return !!item.reviewConfirmed && !this.expandedKeys().has(this.store.trackByMessageId(0, item));
  }

  toggleExpand(item: InvoiceReviewItem): void {
    const key = this.store.trackByMessageId(0, item);
    this.expandedKeys.update(keys => {
      const next = new Set(keys);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  /** Confirms edits on an already-confirmed invoice, then collapses it on success. */
  async confirmEdits(item: InvoiceReviewItem): Promise<void> {
    const applied = await this.store.confirmEdits(item);
    if (applied) this.collapse(item);
  }

  private collapse(item: InvoiceReviewItem): void {
    const key = this.store.trackByMessageId(0, item);
    this.expandedKeys.update(keys => {
      if (!keys.has(key)) return keys;
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
  }
}
