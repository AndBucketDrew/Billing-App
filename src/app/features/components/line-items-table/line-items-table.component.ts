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
  
  vatOptions: VatOption[] = [
    { value: 0, label: 'VAT.RATE_0' },
    { value: 10, label: 'VAT.RATE_10' },
    { value: 13, label: 'VAT.RATE_13' },
    { value: 20, label: 'VAT.RATE_20' }
  ];

  constructor(
    private invoiceService: InvoiceService,
    private translate: TranslateService
  ) {}

  /**
   * Start editing a field
   */
  startEdit(itemId: string, field: string): void {
    this.editingItemId = itemId;
    this.editingField = field;
  }

  /**
   * Check if field is being edited
   */
  isEditing(itemId: string, field: string): boolean {
    return this.editingItemId === itemId && this.editingField === field;
  }

  /**
   * Update item field
   */
  updateField(item: InvoiceLineItem, field: string, value: any): void {
    const index = this.lineItems.findIndex(i => i.id === item.id);
    if (index === -1) return;

    // Update the field
    const updatedItem = { ...item, [field]: value };

    // Recalculate totals if quantity, price, or VAT changed
    if (field === 'quantity' || field === 'unitPriceNet' || field === 'vatPercentage') {
      const recalculated = this.invoiceService.recalculateLineItem(updatedItem);
      this.lineItems[index] = recalculated;
    } else {
      this.lineItems[index] = updatedItem;
    }

    // Stop editing
    this.editingItemId = null;
    this.editingField = null;

    // Emit changes
    this.lineItemsChange.emit([...this.lineItems]);
  }

  /**
   * Delete line item
   */
  deleteItem(item: InvoiceLineItem): void {
    const confirmed = confirm(this.translate.instant('COMMON.DELETE') + '?');
    
    if (confirmed) {
      this.lineItems = this.lineItems.filter(i => i.id !== item.id);
      
      // Update sort order
      this.lineItems.forEach((item, index) => {
        item.sortOrder = index;
      });
      
      this.lineItemsChange.emit([...this.lineItems]);
    }
  }

  /**
   * Add custom line item
   */
  addCustomLineItem(): void {
    const newItem = this.invoiceService.createLineItem({
      description: this.translate.instant('INVOICE.LINE_ITEMS'),
      quantity: 1,
      unitPriceNet: 0,
      vatPercentage: 13,
      sortOrder: this.lineItems.length
    });

    this.lineItems.push(newItem);
    this.lineItemsChange.emit([...this.lineItems]);

    // Start editing description
    setTimeout(() => {
      this.startEdit(newItem.id, 'description');
    }, 100);
  }

  /**
   * Format currency
   */
  formatCurrency(value: number): string {
    const locale = this.translate.currentLang === 'de' ? 'de-DE' : 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'EUR'
    }).format(value);
  }

  /**
   * Get VAT label
   */
  getVatLabel(vatRate: VatRate): string {
    return this.translate.instant(`VAT.RATE_${vatRate}`);
  }

  /**
   * Handle Enter key to stop editing
   */
  onKeydown(event: KeyboardEvent, item: InvoiceLineItem, field: string): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const target = event.target as HTMLInputElement;
      this.updateField(item, field, target.value);
    } else if (event.key === 'Escape') {
      this.editingItemId = null;
      this.editingField = null;
    }
  }
}