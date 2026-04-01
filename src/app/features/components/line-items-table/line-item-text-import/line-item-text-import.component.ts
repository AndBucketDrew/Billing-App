import { Component, EventEmitter, Input, Output, AfterViewChecked, ViewChild, ElementRef } from '@angular/core';
import { InvoiceLineItem, VatRate } from '../../../../core/models/domain.models';
import { SettingsService } from '../../../../core/services/settings.service';
import { InvoiceService } from '../../../../core/services/invoice.service';
import { ParsedLineItem, ParseResult } from '../../../../core/models/line-item-parser/line-item-parser.types';
import { parseTextToLineItems } from './line-item-parser';
import { cleanDescription } from './line-item-helpers';

@Component({
  selector: 'app-text-import',
  templateUrl: './line-item-text-import.component.html',
  styleUrls: ['./line-item-text-import.component.scss'],
  standalone: false,
})
export class LineItemTextImport implements AfterViewChecked {
  @Input() existingItemCount = 0;
  @Output() itemsConfirmed = new EventEmitter<InvoiceLineItem[]>();

  @ViewChild('inlineInput') inlineInput?: ElementRef<HTMLInputElement | HTMLSelectElement>;

  pasteText = '';
  previewResult: ParseResult | null = null;
  isExpanded = false;

  // ── Inline editing state ──────────────────────────────────────────────────
  editingIndex: number | null = null;
  editingField: keyof ParsedLineItem | null = null;
  editingValue: string = '';
  private shouldFocus = false;

  readonly vatOptions: VatRate[] = [0, 10, 13, 20];

  constructor(
    private settingsService: SettingsService,
    private invoiceService: InvoiceService,
  ) { }

  ngAfterViewChecked(): void {
    if (!this.shouldFocus) return;
    this.shouldFocus = false;
    this.inlineInput?.nativeElement.focus();
    if (this.inlineInput?.nativeElement instanceof HTMLInputElement) {
      this.inlineInput.nativeElement.select();
    }
  }

  // ── Skipped line actions ──────────────────────────────────────────────────────

  acknowledgeSkipped(index: number): void {
    if (!this.previewResult) return;

    const skippedLine = this.previewResult.skipped[index];

    // Pre-fill description from the raw line — user can correct in preview table
    const newItem: ParsedLineItem = {
      description: cleanDescription(skippedLine.line) || skippedLine.line.trim(),
      quantity: 1,
      unitPriceNet: 0,
      vatPercentage: this.settingsService.getSettings().defaultVatPercentage as VatRate,
    };

    const updatedItems = [...this.previewResult.items, newItem];
    const updatedSkipped = this.previewResult.skipped.filter((_, i) => i !== index);

    this.previewResult = { items: updatedItems, skipped: updatedSkipped };

    // Auto-open editing on the price field of the newly added row — it's always 0
    const newIndex = updatedItems.length - 1;
    setTimeout(() => this.startEdit(newIndex, 'unitPriceNet', 0));
  }

  dismissSkipped(index: number): void {
    if (!this.previewResult) return;
    const updatedSkipped = this.previewResult.skipped.filter((_, i) => i !== index);
    this.previewResult = { ...this.previewResult, skipped: updatedSkipped };
  }

  // ── Parse ─────────────────────────────────────────────────────────────────

  preview(): void {
    const defaultVat = this.settingsService.getSettings().defaultVatPercentage as VatRate;
    this.previewResult = parseTextToLineItems(this.pasteText, defaultVat);
    this.cancelEdit();
  }

  // ── Inline edit ───────────────────────────────────────────────────────────

  startEdit(index: number, field: keyof ParsedLineItem, currentValue: any): void {
    this.editingIndex = index;
    this.editingField = field;
    this.editingValue = String(currentValue);
    this.shouldFocus = true;
  }

  isEditing(index: number, field: keyof ParsedLineItem): boolean {
    return this.editingIndex === index && this.editingField === field;
  }

  commitEdit(index: number, field: keyof ParsedLineItem): void {
    if (this.editingIndex !== index || this.editingField !== field) return;
    if (!this.previewResult) return;

    const item = { ...this.previewResult.items[index] };

    switch (field) {
      case 'description':
        item.description = this.editingValue.trim() || item.description;
        break;
      case 'quantity':
        item.quantity = Math.max(1, parseFloat(this.editingValue) || 1);
        break;
      case 'unitPriceNet':
        item.unitPriceNet = Math.max(0, parseFloat(this.editingValue) || 0);
        break;
    }

    const updatedItems = [...this.previewResult.items];
    updatedItems[index] = item;
    this.previewResult = { ...this.previewResult, items: updatedItems };

    this.cancelEdit();
  }

  commitVat(index: number, event: Event): void {
    if (!this.previewResult) return;
    const value = +(event.target as HTMLSelectElement).value as VatRate;
    const updatedItems = [...this.previewResult.items];
    updatedItems[index] = { ...updatedItems[index], vatPercentage: value };
    this.previewResult = { ...this.previewResult, items: updatedItems };
    this.cancelEdit();
  }

  onKeydown(event: KeyboardEvent, index: number, field: keyof ParsedLineItem): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitEdit(index, field);
    } else if (event.key === 'Escape') {
      this.cancelEdit();
    }
  }

  cancelEdit(): void {
    this.editingIndex = null;
    this.editingField = null;
    this.editingValue = '';
  }

  deletePreviewItem(index: number): void {
    if (!this.previewResult) return;
    const updatedItems = this.previewResult.items.filter((_, i) => i !== index);
    this.previewResult = { ...this.previewResult, items: updatedItems };
  }

  // ── Confirm ───────────────────────────────────────────────────────────────

  confirm(): void {
    if (!this.previewResult?.items.length) return;

    const created: InvoiceLineItem[] = this.previewResult.items.map(
      (parsed: ParsedLineItem, i: number) =>
        this.invoiceService.createLineItem({
          ...parsed,
          sortOrder: this.existingItemCount + i,
        })
    );

    this.itemsConfirmed.emit(created);
    this.isExpanded = false;
    this.clear();
  }

  clear(): void {
    this.pasteText = '';
    this.previewResult = null;
    this.cancelEdit();
  }

  get hasItems(): boolean {
    return (this.previewResult?.items.length ?? 0) > 0;
  }

  get hasSkipped(): boolean {
    return (this.previewResult?.skipped.length ?? 0) > 0;
  }
}