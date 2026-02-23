import { Component, Inject, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { Tour, VatRate } from '../../../core/models/domain.models';

export interface TourFormDialogData {
  mode: 'create' | 'edit';
  tour?: Tour;
}

@Component({
  selector: 'app-tour-form-dialog',
  templateUrl: './tour-form-dialog.component.html',
  styleUrls: ['./tour-form-dialog.component.scss'],
  standalone: false,
})
export class TourFormDialogComponent implements OnInit {
  tourForm: FormGroup;
  isEditMode: boolean;

  constructor(
    private fb: FormBuilder,
    public dialogRef: MatDialogRef<TourFormDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: TourFormDialogData
  ) {
    this.isEditMode = data.mode === 'edit';
    
    // Initialize form - removed VAT, added meeting point
    this.tourForm = this.fb.group({
      name: ['', [Validators.required, Validators.minLength(2)]],
      description: [''],
      meetingPoint: ['', [Validators.required]],
      basePriceNet: [0, [Validators.required, Validators.min(0)]]
    });
  }

  ngOnInit(): void {
    // Populate form in edit mode
    if (this.isEditMode && this.data.tour) {
      this.tourForm.patchValue({
        name: this.data.tour.name,
        description: this.data.tour.description,
        meetingPoint: this.data.tour.meetingPoint,
        basePriceNet: this.data.tour.basePriceNet
      });
    }
  }

  /**
   * Get dialog title based on mode
   */
  getDialogTitle(): string {
    return this.isEditMode ? 'TOUR.EDIT' : 'TOUR.CREATE';
  }

  /**
   * Submit form
   */
  onSubmit(): void {
    if (this.tourForm.valid) {
      const formValue = this.tourForm.value;
      
      // Ensure basePriceNet is a number
      const tourData = {
        ...formValue,
        basePriceNet: parseFloat(formValue.basePriceNet)
      };
      
      this.dialogRef.close(tourData);
    }
  }

  /**
   * Cancel and close dialog
   */
  onCancel(): void {
    this.dialogRef.close();
  }

  /**
   * Get error message for a field
   */
  getErrorMessage(fieldName: string): string {
    const field = this.tourForm.get(fieldName);
    
    if (field?.hasError('required')) {
      return 'MESSAGES.REQUIRED_FIELD';
    }
    
    if (field?.hasError('minLength')) {
      return 'MESSAGES.MIN_VALUE';
    }
    
    if (field?.hasError('min')) {
      return 'MESSAGES.MIN_VALUE';
    }
    
    return '';
  }
}