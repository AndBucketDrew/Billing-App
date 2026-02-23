import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SettingsService } from '../../core/services/settings.service';
import { CompanySettings, VatRate } from '../../core/models/domain.models';
import { TranslateService } from '@ngx-translate/core';

interface VatOption {
  value: VatRate;
  label: string;
}

@Component({
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.scss'],
  standalone: false
})
export class SettingsComponent implements OnInit {
  settingsForm: FormGroup;
  currentLogoPath: string = '';
  isLoading: boolean = false;
  
 vatOptions: VatOption[] = [
    { value: 0, label: 'VAT.RATE_0' },
    { value: 10, label: 'VAT.RATE_10' },
    { value: 13, label: 'VAT.RATE_13' },
    { value: 20, label: 'VAT.RATE_20' }
  ];

  languageOptions = [
    { value: 'de', label: 'Deutsch', flag: '🇩🇪' },
    { value: 'en', label: 'English', flag: '🇬🇧' }
  ];

  constructor(
    private fb: FormBuilder,
    private settingsService: SettingsService,
    private snackBar: MatSnackBar,
    private translate: TranslateService
  ) {
    // Initialize form with all fields
    this.settingsForm = this.fb.group({
      // Basic company info
      companyName: ['', [Validators.required, Validators.minLength(2)]],
      companyAddress: ['', [Validators.required]],
      cityCountry: ['', [Validators.required]],
      vatNumber: ['', [Validators.required]],
      
      // Bank details
      bankName: [''],
      accountHolder: [''],
      iban: [''],
      bic: [''],
      
      // Legal details
      legalForm: [''],
      headquarters: [''],
      courtRegistry: [''],
      registrationNumber: [''],
      
      // Invoice settings
      invoiceFooterText: [''],
      defaultVatPercentage: [13, [Validators.required]],
      language: ['de', [Validators.required]]
    });
  }

  ngOnInit(): void {
    this.loadSettings();
  }

  /**
   * Load current settings
   */
  async loadSettings(): Promise<void> {
    this.isLoading = true;
    
    try {
      await this.settingsService.loadSettings();
      
      this.settingsService.settings$.subscribe((settings: CompanySettings) => {
        this.settingsForm.patchValue({
          companyName: settings.companyName,
          companyAddress: settings.companyAddress,
          cityCountry: settings.cityCountry,
          vatNumber: settings.vatNumber,
          bankName: settings.bankName,
          accountHolder: settings.accountHolder,
          iban: settings.iban,
          bic: settings.bic,
          legalForm: settings.legalForm,
          headquarters: settings.headquarters,
          courtRegistry: settings.courtRegistry,
          registrationNumber: settings.registrationNumber,
          invoiceFooterText: settings.invoiceFooterText,
          defaultVatPercentage: settings.defaultVatPercentage,
          language: settings.language
        });
        
        this.currentLogoPath = settings.logoPath || '';
      });
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error loading settings:', error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Save settings
   */
  async onSave(): Promise<void> {
    if (this.settingsForm.invalid) {
      this.settingsForm.markAllAsTouched();
      return;
    }

    this.isLoading = true;

    try {
      const formValue = this.settingsForm.value;
      
      await this.settingsService.updateSettings({
        companyName: formValue.companyName,
        companyAddress: formValue.companyAddress,
        cityCountry: formValue.cityCountry,
        vatNumber: formValue.vatNumber,
        bankName: formValue.bankName,
        accountHolder: formValue.accountHolder,
        iban: formValue.iban,
        bic: formValue.bic,
        legalForm: formValue.legalForm,
        headquarters: formValue.headquarters,
        courtRegistry: formValue.courtRegistry,
        registrationNumber: formValue.registrationNumber,
        invoiceFooterText: formValue.invoiceFooterText,
        defaultVatPercentage: formValue.defaultVatPercentage,
        language: formValue.language
      });

      this.showMessage(this.translate.instant('SETTINGS.SAVE_SUCCESS'));
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error saving settings:', error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Select logo file
   */
  async onSelectLogo(): Promise<void> {
    try {
      const logoPath = await this.settingsService.selectLogo();
      
      if (logoPath) {
        this.currentLogoPath = logoPath;
        this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
      }
    } catch (error) {
      this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
      console.error('Error selecting logo:', error);
    }
  }

  /**
   * Remove logo
   */
  async onRemoveLogo(): Promise<void> {
    const confirmed = confirm(this.translate.instant('SETTINGS.LOGO_REMOVE') + '?');
    
    if (confirmed) {
      try {
        await this.settingsService.removeLogo();
        this.currentLogoPath = '';
        this.showMessage(this.translate.instant('MESSAGES.SAVE_SUCCESS'));
      } catch (error) {
        this.showMessage(this.translate.instant('MESSAGES.ERROR'), 'error');
        console.error('Error removing logo:', error);
      }
    }
  }

  /**
   * Change language
   */
  async onLanguageChange(language: 'de' | 'en'): Promise<void> {
    try {
      await this.settingsService.changeLanguage(language);
      // Form value will update automatically via subscription
    } catch (error) {
      console.error('Error changing language:', error);
    }
  }

  /**
   * Get logo display path for preview
   */
  getLogoPreview(): string {
    // In Electron, we need to use file:// protocol for local files
    return this.currentLogoPath ? `file://${this.currentLogoPath}` : '';
  }

  /**
   * Check if logo exists
   */
  hasLogo(): boolean {
    return !!this.currentLogoPath;
  }

  /**
   * Get error message for a field
   */
  getErrorMessage(fieldName: string): string {
    const field = this.settingsForm.get(fieldName);
    
    if (field?.hasError('required')) {
      return this.translate.instant('MESSAGES.REQUIRED_FIELD');
    }
    
    if (field?.hasError('minLength')) {
      const minLength = field.errors?.['minLength'].requiredLength;
      return this.translate.instant('MESSAGES.MIN_VALUE', { min: minLength });
    }
    
    return '';
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