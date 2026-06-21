import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

export interface ExportConfirmData {
  count: number;
}

export interface ExportConfirmResult {
  markExported: boolean;
}

/**
 * Confirmation dialog shown before an Excel export. Lets the user decide whether the
 * exported invoices should be flagged as "Exported" — e.g. unchecked when they're just
 * testing the output and don't want the rows marked. Closes with `undefined` on cancel.
 */
@Component({
  selector: 'app-export-confirm-dialog',
  standalone: false,
  template: `
    <h2 mat-dialog-title>Export to Excel</h2>
    <mat-dialog-content>
      <p class="export-msg">
        Export <strong>{{ data.count }}</strong> confirmed invoice{{ data.count === 1 ? '' : 's' }} to an Excel file.
      </p>
      <mat-checkbox [(ngModel)]="markExported" color="primary">
        Mark these invoices as <strong>Exported</strong>
      </mat-checkbox>
      <p class="export-hint">
        Leave unchecked if you're just testing the output — the rows stay unflagged so you can export again.
      </p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button [mat-dialog-close]="undefined">Cancel</button>
      <button mat-raised-button color="primary" (click)="confirm()">
        <mat-icon>download</mat-icon>
        Export
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .export-msg { margin: 0 0 16px; font-size: var(--font-size-md); color: var(--color-fg-default); }
    .export-hint { margin: 10px 0 0 32px; font-size: var(--font-size-xs); color: var(--color-fg-muted); line-height: 1.5; }
    mat-dialog-actions { gap: 8px; }
    button[mat-raised-button] mat-icon { margin-right: 4px; }
  `],
})
export class ExportConfirmDialogComponent {
  markExported = true;

  constructor(
    public readonly dialogRef: MatDialogRef<ExportConfirmDialogComponent, ExportConfirmResult | undefined>,
    @Inject(MAT_DIALOG_DATA) public readonly data: ExportConfirmData,
  ) {}

  confirm(): void {
    this.dialogRef.close({ markExported: this.markExported });
  }
}
