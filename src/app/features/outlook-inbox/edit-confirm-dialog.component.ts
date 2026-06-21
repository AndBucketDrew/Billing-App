import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';

export interface EditConfirmResult {
  dontShowAgain: boolean;
}

/**
 * Acknowledgement shown when the user confirms edits made to an already-confirmed invoice
 * on the PDF Parser's Confirmed tab. Confirming clears the invoice's "exported" flag so it
 * is included in the next Excel export. A "don't show this again" checkbox lets the user
 * suppress the dialog for future edits (persisted in localStorage by the store). Closes with
 * `undefined` on cancel.
 */
@Component({
  selector: 'app-edit-confirm-dialog',
  standalone: false,
  template: `
    <h2 mat-dialog-title>Changes confirmed</h2>
    <mat-dialog-content>
      <p class="edit-msg">
        This invoice will be <strong>exported again</strong> on the next Excel export.
      </p>
      <mat-checkbox [(ngModel)]="dontShowAgain" color="primary">
        Don't show this again
      </mat-checkbox>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-stroked-button [mat-dialog-close]="undefined">Cancel</button>
      <button mat-raised-button color="primary" (click)="confirm()">
        <mat-icon>check</mat-icon>
        OK
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .edit-msg { margin: 0 0 16px; font-size: var(--font-size-md); color: var(--color-fg-default); line-height: 1.5; }
    mat-dialog-actions { gap: 8px; }
    button[mat-raised-button] mat-icon { margin-right: 4px; }
  `],
})
export class EditConfirmDialogComponent {
  dontShowAgain = false;

  constructor(
    public readonly dialogRef: MatDialogRef<EditConfirmDialogComponent, EditConfirmResult | undefined>,
  ) {}

  confirm(): void {
    this.dialogRef.close({ dontShowAgain: this.dontShowAgain });
  }
}
