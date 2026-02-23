import { Component, OnInit } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { TourService } from '../../../core/services/tour.service';
import { Tour, VatRate } from '../../../core/models/domain.models';
import { Observable } from 'rxjs';
import { SettingsService } from '../../../core/services/settings.service';

interface TourSelection {
  tour: Tour;
  selected: boolean;
  quantity: number;
  vatPercentage: VatRate;
}

interface VatOption {
  value: VatRate;
  label: string;
}

@Component({
  selector: 'app-tour-selector-dialog',
  templateUrl: './tour-selector-dialog.component.html',
  styleUrls: ['./tour-selector-dialog.component.scss'],
  standalone: false,
})
export class TourSelectorDialogComponent implements OnInit {
  tours$: Observable<Tour[]>;
  tourSelections: TourSelection[] = [];
  searchText: string = '';
  
  vatOptions: VatOption[] = [
    { value: 0, label: 'VAT.RATE_0' },
    { value: 10, label: 'VAT.RATE_10' },
    { value: 13, label: 'VAT.RATE_13' },
    { value: 20, label: 'VAT.RATE_20' }
  ];

  constructor(
    private tourService: TourService,
    private settingsService: SettingsService,
    public dialogRef: MatDialogRef<TourSelectorDialogComponent>
  ) {
    this.tours$ = this.tourService.tours$;
  }

  ngOnInit(): void {
    const defaultVat = this.settingsService.getSettings().defaultVatPercentage;
    
    this.tourService.tours$.subscribe(tours => {
      this.tourSelections = tours.map(tour => ({
        tour,
        selected: false,
        quantity: 1,
        vatPercentage: defaultVat // Use default VAT from settings
      }));
    });
  }

  /**
   * Toggle tour selection
   */
  toggleSelection(selection: TourSelection): void {
    selection.selected = !selection.selected;
  }

  /**
   * Update quantity for a tour
   */
  updateQuantity(selection: TourSelection, quantity: number): void {
    if (quantity < 1) quantity = 1;
    selection.quantity = quantity;
  }

  /**
   * Update VAT for a tour
   */
  updateVat(selection: TourSelection, vat: VatRate): void {
    selection.vatPercentage = vat;
  }

  /**
   * Calculate line total with VAT
   */
  calculateLineTotal(selection: TourSelection): number {
    const net = selection.tour.basePriceNet * selection.quantity;
    const vatAmount = net * (selection.vatPercentage / 100);
    return net + vatAmount;
  }

  /**
   * Get filtered tours based on search
   */
  getFilteredSelections(): TourSelection[] {
    if (!this.searchText.trim()) {
      return this.tourSelections;
    }

    const search = this.searchText.toLowerCase();
    return this.tourSelections.filter(s => 
      s.tour.name.toLowerCase().includes(search) ||
      s.tour.description.toLowerCase().includes(search)
    );
  }

  /**
   * Get selected count
   */
  getSelectedCount(): number {
    return this.tourSelections.filter(s => s.selected).length;
  }

  /**
   * Confirm selection
   */
  onConfirm(): void {
    const selected = this.tourSelections
      .filter(s => s.selected)
      .map(s => ({
        tour: s.tour,
        quantity: s.quantity,
        vatPercentage: s.vatPercentage // Include selected VAT
      }));
    
    this.dialogRef.close(selected);
  }

  /**
   * Cancel
   */
  onCancel(): void {
    this.dialogRef.close();
  }

  /**
   * Format currency
   */
  formatCurrency(value: number): string {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR'
    }).format(value);
  }
}
