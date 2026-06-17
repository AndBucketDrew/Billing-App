import { Component, Inject } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';

export interface CustomerProfile {
  customerName: string;
  salutation: string | null;
  customerEmail: string | null;
  companyName: string | null;
  companyAddress: string | null;
  companyCityCountry: string | null;
  companyTaxId: string | null;
  companyCustomerName: string | null;
  purchaseOrderNumber: string | null;
}

export interface CustomerPickerData {
  customers: CustomerProfile[];
  recentCustomers: CustomerProfile[];
}

@Component({
  selector: 'app-customer-picker-dialog',
  templateUrl: './customer-picker-dialog.component.html',
  styleUrls: ['./customer-picker-dialog.component.scss'],
  standalone: false,
})
export class CustomerPickerDialogComponent {
  searchText: string = '';

  constructor(
    public dialogRef: MatDialogRef<CustomerPickerDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: CustomerPickerData
  ) {}

  getDisplayedCustomers(): CustomerProfile[] {
    if (!this.searchText.trim()) {
      return this.data.recentCustomers;
    }
    const filter = this.searchText.toLowerCase();
    const results: CustomerProfile[] = [];
    for (const c of this.data.customers) {
      if (c.customerName.toLowerCase().includes(filter)) {
        results.push(c);
        if (results.length === 20) break;
      }
    }
    return results;
  }

  isSearchActive(): boolean {
    return this.searchText.trim().length > 0;
  }

  select(customer: CustomerProfile): void {
    this.dialogRef.close(customer);
  }

  cancel(): void {
    this.dialogRef.close();
  }
}
