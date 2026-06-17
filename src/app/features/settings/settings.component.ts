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

  readonly emailTemplateVarList = [
    { label: '{invoiceNumber}', tooltip: 'Invoice number (e.g. 260610-1323-022)' },
    { label: '{date}',          tooltip: 'Invoice date (e.g. 16.06.2026)' },
    { label: '{total}',         tooltip: 'Total amount including VAT (e.g. €1.234,00)' },
    { label: '{customer}',      tooltip: 'Customer name (e.g. Max Mustermann)' },
    { label: '{companyName}',   tooltip: 'Your company name (e.g. Muster GmbH)' },
    { label: '{paymentMethod}', tooltip: 'Payment method (e.g. Bank Transfer)' },
    { label: '{docType}',       tooltip: 'Document type (e.g. Invoice or Credit Note)' },
    { label: '{filename}',      tooltip: 'PDF attachment filename (e.g. Invoice_260610-1323-022.pdf)' },
  ];
  private static readonly TEMPLATE_KEYWORDS = ['invoiceNumber', 'date', 'total', 'customer', 'companyName', 'paymentMethod', 'docType', 'filename'];

  private static readonly DEFAULT_SUBJECT_DE = 'Rechnung Nr. {invoiceNumber} – {companyName}';
  private static readonly DEFAULT_SUBJECT_EN = 'Invoice No. {invoiceNumber} – {companyName}';
  private static readonly DEFAULT_BODY_DE =
`Sehr geehrte/r {customer},

anbei erhalten Sie Ihre {docType} Nr. {invoiceNumber} vom {date}.

Bei Fragen stehen wir Ihnen gerne zur Verfügung.

Mit freundlichen Grüßen
{companyName}`;
  private static readonly DEFAULT_BODY_EN =
`Dear {customer},

please find enclosed your {docType} no. {invoiceNumber} dated {date}.

Should you have any questions, please don't hesitate to contact us.

Kind regards,
{companyName}`;

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
      //Invoice index counter
      invoiceCounter: [1, [Validators.required, Validators.min(1)]],

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
      brandColor: ['#8a9a6a'],
      invoiceFooterText: [''],
      defaultVatPercentage: [13, [Validators.required]],
      language: ['de', [Validators.required]],

      // Email templates
      emailSubjectDe: [''],
      emailSubjectEn: [''],
      emailBodyDe: [''],
      emailBodyEn: [''],
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
          invoiceCounter: settings.invoiceCounter ?? 1,
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
          brandColor: settings.brandColor ?? '#8a9a6a',
          invoiceFooterText: settings.invoiceFooterText,
          defaultVatPercentage: settings.defaultVatPercentage,
          language: settings.language,
          emailSubjectDe: settings.emailSubjectDe ?? SettingsComponent.DEFAULT_SUBJECT_DE,
          emailSubjectEn: settings.emailSubjectEn ?? SettingsComponent.DEFAULT_SUBJECT_EN,
          emailBodyDe: settings.emailBodyDe ?? SettingsComponent.DEFAULT_BODY_DE,
          emailBodyEn: settings.emailBodyEn ?? SettingsComponent.DEFAULT_BODY_EN,
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

      const emailSubjectDe = this.parseTemplateVariables(formValue.emailSubjectDe || undefined);
      const emailSubjectEn = this.parseTemplateVariables(formValue.emailSubjectEn || undefined);
      const emailBodyDe = this.parseTemplateVariables(formValue.emailBodyDe || undefined);
      const emailBodyEn = this.parseTemplateVariables(formValue.emailBodyEn || undefined);

      this.settingsForm.patchValue({
        emailSubjectDe: emailSubjectDe ?? '',
        emailSubjectEn: emailSubjectEn ?? '',
        emailBodyDe: emailBodyDe ?? '',
        emailBodyEn: emailBodyEn ?? '',
      }, { emitEvent: false });

      await this.settingsService.updateSettings({
        invoiceCounter: formValue.invoiceCounter,
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
        brandColor: formValue.brandColor || '#8a9a6a',
        invoiceFooterText: formValue.invoiceFooterText,
        defaultVatPercentage: formValue.defaultVatPercentage,
        language: formValue.language,
        emailSubjectDe,
        emailSubjectEn,
        emailBodyDe,
        emailBodyEn,
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

  private parseTemplateVariables(text: string | undefined): string | undefined {
    if (!text) return undefined;
    let result = text;
    for (const kw of SettingsComponent.TEMPLATE_KEYWORDS) {
      result = result.replace(new RegExp(`(?<!\\{)\\b${kw}\\b(?!\\})`, 'g'), `{${kw}}`);
    }
    return result;
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