import { Component, Input, Output, EventEmitter } from '@angular/core';
import { InvoiceService } from '../../../core/services/invoice.service';
import { InvoiceLineItem, VatRate } from '../../../core/models/domain.models';
import { TranslateService } from '@ngx-translate/core';

interface VatOption {
  value: VatRate;
  label: string;
}

@Component({
  selector: 'app-line-items-table',
  templateUrl: './line-items-table.component.html',
  styleUrls: ['./line-items-table.component.scss'],
  standalone: false,
})
export class LineItemsTableComponent {
  @Input() lineItems: InvoiceLineItem[] = [];
  @Output() lineItemsChange = new EventEmitter<InvoiceLineItem[]>();

  displayedColumns: string[] = ['description', 'quantity', 'unitPriceNet', 'vatPercentage', 'lineTotalGross', 'actions'];

  editingItemId: string | null = null;
  editingField: string | null = null;
  editingValue: any = null;

  vatOptions: VatOption[] = [
    { value: 0,  label: 'VAT.RATE_0'  },
    { value: 10, label: 'VAT.RATE_10' },
    { value: 13, label: 'VAT.RATE_13' },
    { value: 20, label: 'VAT.RATE_20' },
  ];

  constructor(
    private invoiceService: InvoiceService,
    private translate: TranslateService
  ) {}

  /** Start editing — seed local value */
  startEdit(itemId: string, field: string, currentValue: any): void {
    this.editingItemId = itemId;
    this.editingField   = field;
    this.editingValue   = currentValue;
  }

  isEditing(itemId: string, field: string): boolean {
    return this.editingItemId === itemId && this.editingField === field;
  }

  /** Track keystrokes for text/number inputs — never emits */
  onEditInput(value: any): void {
    this.editingValue = value;
  }

  /** Commit text/number inputs on blur or Enter */
  commitEdit(item: InvoiceLineItem, field: string): void {
    if (this.editingItemId !== item.id || this.editingField !== field) return;
    // 0 is a valid value — only skip true null/undefined
    if (this.editingValue === null || this.editingValue === undefined) return;
    this.applyValue(item, field, this.editingValue);
  }

  /**
   * Dedicated VAT select handler.
   * Reads the selected value directly from the DOM event so:
   *  - we never race against editingValue assignment
   *  - selecting 0% always works because (change) fires on any option pick
   *  - NO blur is wired for the select — clicking away without changing is safe
   */
  commitVat(event: Event, item: InvoiceLineItem): void {
    const selected = +(event.target as HTMLSelectElement).value as VatRate;
    this.applyValue(item, 'vatPercentage', selected);
  }

  /** Shared write + emit logic */
  private applyValue(item: InvoiceLineItem, field: string, value: any): void {
    const index = this.lineItems.findIndex(i => i.id === item.id);
    if (index === -1) return;

    const numericFields = ['quantity', 'unitPriceNet', 'vatPercentage'];
    const parsed = numericFields.includes(field) ? +value : value;

    const updatedItem = { ...item, [field]: parsed };
    const finalItem   = numericFields.includes(field)
      ? this.invoiceService.recalculateLineItem(updatedItem)
      : updatedItem;

    const newItems    = [...this.lineItems];
    newItems[index]   = finalItem;
    this.lineItems    = newItems;

    this.editingItemId = null;
    this.editingField  = null;
    this.editingValue  = null;

    this.lineItemsChange.emit([...this.lineItems]);
  }

  onKeydown(event: KeyboardEvent, item: InvoiceLineItem, field: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit(item, field);
    } else if (event.key === 'Escape') {
      this.editingItemId = null;
      this.editingField  = null;
      this.editingValue  = null;
    }
  }

  deleteItem(item: InvoiceLineItem): void {
    if (!confirm(this.translate.instant('COMMON.DELETE') + '?')) return;
    this.lineItems = this.lineItems
      .filter(i => i.id !== item.id)
      .map((li, idx) => ({ ...li, sortOrder: idx }));
    this.lineItemsChange.emit([...this.lineItems]);
  }

  addCustomLineItem(): void {
    const newItem = this.invoiceService.createLineItem({
      description:   this.translate.instant('INVOICE.LINE_ITEMS'),
      quantity:      1,
      unitPriceNet:  0,
      vatPercentage: 13,
      sortOrder:     this.lineItems.length,
    });

    this.lineItems = [...this.lineItems, newItem];
    this.lineItemsChange.emit([...this.lineItems]);

    setTimeout(() => this.startEdit(newItem.id, 'description', newItem.description), 100);
  }

  formatCurrency(value: number): string {
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value);
  }

  getVatLabel(vatRate: VatRate): string {
    return this.translate.instant(`VAT.RATE_${vatRate}`);
  }
}