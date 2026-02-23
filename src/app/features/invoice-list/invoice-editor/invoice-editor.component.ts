import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { InvoiceService } from '../../../core/services/invoice.service';
import { SettingsService } from '../../../core/services/settings.service';
import { Invoice, InvoiceLineItem, VatRate } from '../../../core/models/domain.models';
import { TourSelectorDialogComponent } from '../../components/tour-selector-dialog/tour-selector-dialog.component';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-invoice-editor',
  templateUrl: './invoice-editor.component.html',
  styleUrls: ['./invoice-editor.component.scss'],
  standalone: false,
})
export class InvoiceEditorComponent implements OnInit {
  invoiceForm: FormGroup;
  lineItems: InvoiceLineItem[] = [];
  isEditMode: boolean = false;
  invoiceId?: string;
  isLoading: boolean = false;
  isSaving: boolean = false;

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private invoiceService: InvoiceService,
    private settingsService: SettingsService,
    private dialog: MatDialog,
    private snackBar: MatSnackBar,
    private translate: TranslateService
  ) {
    const today = new Date().toISOString().split('T')[0];
    const settings = this.settingsService.getSettings();

    // Initialize form
    this.invoiceForm = this.fb.group({
      invoiceDate: [today, [Validators.required]],
      language: [settings.language, [Validators.required]],

      // Customer
      customerName: ['', [Validators.required, Validators.minLength(2)]],
      customerEmail: ['', [Validators.email]], // optional

      // Company (all optional)
      companyName: [''],
      companyAddress: [''],
      companyCityCountry: [''],

      // Tour details
      tourDate: [''],   // Am – optional
      pax: [null, [Validators.min(1)]], // optional
      guide: [''],      // optional
    });
  }

  ngOnInit(): void {
    this.route.params.subscribe(params => {
      if (params['id']) {
        this.isEditMode = true;
        this.invoiceId = params['id'];
        this.loadInvoice(params['id']);
      }
    });
  }

  /**
   * Load existing invoice for editing
   */
  async loadInvoice(id: string): Promise<void> {
    this.isLoading = true;

    try {
      const invoice = await this.invoiceService.getInvoiceById(id);

      if (invoice) {
        if (invoice.status === 'finalized') {
          this.showMessage(
            this.translate.instant('INVOICE.STATUS_FINALIZED'),
            'error'
          );
          this.router.navigate(['/invoices']);
          return;
        }

        this.invoiceForm.patchValue({
          invoiceDate: invoice.invoiceDate,
          language: invoice.language,
          customerName: invoice.customerName,
          customerEmail: invoice.customerEmail ?? '',
          companyName: invoice.companyName ?? '',
          companyAddress: invoice.companyAddress ?? '',
          companyCityCountry: invoice.companyCityCountry ?? '',
          tourDate: invoice.tourDate ?? '',
          pax: invoice.pax ?? null,
          guide: invoice.guide ?? '',
        });

        this.lineItems = [...invoice.lineItems];
      }
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error loading invoice:', error);
      this.router.navigate(['/invoices']);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Open tour selector dialog
   */
  openTourSelector(): void {
    const dialogRef = this.dialog.open(TourSelectorDialogComponent, {
      width: '700px',
      maxHeight: '80vh'
    });

    dialogRef.afterClosed().subscribe(selectedTours => {
      if (selectedTours && selectedTours.length > 0) {
        selectedTours.forEach((selection: any) => {
          this.addTourAsLineItem(selection.tour, selection.quantity, selection.vatPercentage);
        });
      }
    });
  }

  /**
   * Add tour as line item
   */
  addTourAsLineItem(tour: any, quantity: number = 1, vatPercentage: VatRate): void {
    const lineItem = this.invoiceService.createLineItem({
      tourId: tour.id,
      description: tour.name,
      quantity,
      unitPriceNet: tour.basePriceNet,
      vatPercentage,
      sortOrder: this.lineItems.length
    });

    this.lineItems.push(lineItem);
  }

  /**
   * Handle line items update from child component
   */
  onLineItemsUpdate(updatedItems: InvoiceLineItem[]): void {
    this.lineItems = updatedItems;
  }

  /**
   * Build shared invoice payload from form
   */
  private buildInvoicePayload() {
    const v = this.invoiceForm.value;
    return {
      invoiceDate: v.invoiceDate,
      language: v.language,
      customerName: v.customerName,
      customerEmail: v.customerEmail || null,
      companyName: v.companyName || null,
      companyAddress: v.companyAddress || null,
      companyCityCountry: v.companyCityCountry || null,
      tourDate: v.tourDate || null,
      pax: v.pax ?? null,
      guide: v.guide || null,
      lineItems: this.lineItems,
    };
  }

  /**
   * Save invoice as draft
   */
  async saveDraft(): Promise<void> {
    if (this.invoiceForm.invalid) {
      this.invoiceForm.markAllAsTouched();
      this.showMessage(this.translate.instant('MESSAGES.REQUIRED_FIELD'), 'error');
      return;
    }

    if (this.lineItems.length === 0) {
      this.showMessage(this.translate.instant('INVOICE.ADD_LINE_ITEM'), 'error');
      return;
    }

    this.isSaving = true;

    try {
      const payload = this.buildInvoicePayload();

      if (this.isEditMode && this.invoiceId) {
        await this.invoiceService.updateInvoice(this.invoiceId, payload);
        this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
      } else {
        const created = await this.invoiceService.createInvoice({
          ...payload,
          customerAddress: '', // legacy field kept for compatibility
        });
        this.invoiceId = created.id; // store for potential finalize step
        this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
        if (!this.isEditMode) {
          // Only navigate away if not chained into finalize
          // Navigation is handled by the caller when finalizing
        }
      }
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error saving invoice:', error);
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Save and finalize invoice
   */
  async saveAndFinalize(): Promise<void> {
    // We need to save first and get the ID
    if (this.invoiceForm.invalid) {
      this.invoiceForm.markAllAsTouched();
      this.showMessage(this.translate.instant('MESSAGES.REQUIRED_FIELD'), 'error');
      return;
    }

    if (this.lineItems.length === 0) {
      this.showMessage(this.translate.instant('INVOICE.ADD_LINE_ITEM'), 'error');
      return;
    }

    this.isSaving = true;

    try {
      const payload = this.buildInvoicePayload();
      let idToFinalize: string;

      if (this.isEditMode && this.invoiceId) {
        await this.invoiceService.updateInvoice(this.invoiceId, payload);
        idToFinalize = this.invoiceId;
      } else {
        const created = await this.invoiceService.createInvoice({
          ...payload,
          customerAddress: '',
        });
        idToFinalize = created.id;
      }

      await this.invoiceService.finalizeInvoice(idToFinalize);
      this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
      this.router.navigate(['/invoices']);
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error finalizing invoice:', error);
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Cancel and go back
   */
  cancel(): void {
    this.router.navigate(['/invoices']);
  }

  /**
   * Get page title
   */
  getPageTitle(): string {
    return this.isEditMode
      ? this.translate.instant('INVOICE.EDIT')
      : this.translate.instant('INVOICE.CREATE');
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