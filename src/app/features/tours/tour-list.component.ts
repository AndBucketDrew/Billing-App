import { Component, OnInit, ViewChild } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTable } from '@angular/material/table';
import { TourService } from '../../core/services/tour.service';
import { Tour, VatRate } from '../../core/models/domain.models';
import { Observable } from 'rxjs';

import { TranslateService } from '@ngx-translate/core';
import { TourFormDialogComponent } from './tour-form-dialog/tour-form-dialog.component';

@Component({
  selector: 'app-tour-list',
  templateUrl: './tour-list.component.html',
  styleUrls: ['./tour-list.component.scss'],
  standalone: false
})
export class TourListComponent implements OnInit {
  tours$: Observable<Tour[]>;
  displayedColumns: string[] = ['name', 'description', 'basePriceNet', 'actions'];
  
  @ViewChild(MatTable) table?: MatTable<Tour>;

 constructor(
    private tourService: TourService,
    private dialog: MatDialog,
    private snackBar: MatSnackBar,
    private translate: TranslateService
  ) {
    this.tours$ = this.tourService.tours$;
  }

  ngOnInit(): void {
    // Tours are automatically loaded by the service
  }

  /**
   * Open create tour dialog
   */
  openCreateDialog(): void {
    const dialogRef = this.dialog.open(TourFormDialogComponent, {
      width: '600px',
      data: { mode: 'create' }
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        this.createTour(result);
      }
    });
  }

  /**
   * Open edit tour dialog
   */
  openEditDialog(tour: Tour): void {
    const dialogRef = this.dialog.open(TourFormDialogComponent, {
      width: '600px',
      data: { mode: 'edit', tour: { ...tour } }
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        this.updateTour(tour.id, result);
      }
    });
  }

  /**
   * Create a new tour
   */
  async createTour(tourData: {
    name: string;
    description: string;
    meetingPoint: string;
    basePriceNet: number;
  }): Promise<void> {
    try {
      await this.tourService.createTour(tourData);
      this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error creating tour:', error);
    }
  }

  /**
   * Update an existing tour
   */
  async updateTour(id: string, updates: Partial<Tour>): Promise<void> {
    try {
      await this.tourService.updateTour(id, updates);
      this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error updating tour:', error);
    }
  }

  /**
   * Delete a tour with confirmation
   */
  async deleteTour(tour: Tour): Promise<void> {
    const confirmed = confirm(this.translate.instant('TOUR.DELETE_CONFIRM'));
    
    if (confirmed) {
      try {
        await this.tourService.deleteTour(tour.id);
        this.showMessage(this.translate.instant('MESSAGES.DELETE_SUCCESS'));
      } catch (error) {
        this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
        console.error('Error deleting tour:', error);
      }
    }
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
   * Show snackbar message
   */
  private showMessage(message: string, type: 'success' | 'error' = 'success'): void {
    this.snackBar.open(message, this.translate.instant('COMMON.CLOSE'), {
      duration: 3000,
      panelClass: type === 'error' ? 'snackbar-error' : 'snackbar-success'
    });
  }
}
