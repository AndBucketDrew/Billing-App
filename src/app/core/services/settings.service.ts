import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService } from './electron.service';
import { TranslateService } from '@ngx-translate/core';
import type { CompanySettings } from '../models/domain.models';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private settingsSubject = new BehaviorSubject<CompanySettings>({
    language: 'de',
    companyName: '',
    companyAddress: '',
    cityCountry: '',
    vatNumber: '',
    logoPath: '',
    defaultVatPercentage: 13,
    bankName: '',
    accountHolder: '',
    iban: '',
    bic: '',
    legalForm: '',
    headquarters: '',
    courtRegistry: '',
    registrationNumber: '',
    invoiceFooterText: ''
  });

  public settings$: Observable<CompanySettings> = this.settingsSubject.asObservable();

  constructor(
    private electron: ElectronService,
    private translate: TranslateService
  ) {
    this.loadSettings();
  }

  /**
   * Load settings from storage
   */
  async loadSettings(): Promise<void> {
    try {
      const settings = await this.electron.api.settings.get();
      this.settingsSubject.next(settings);
      
      // Apply language setting
      this.translate.use(settings.language);
    } catch (error) {
      console.error('Error loading settings:', error);
      throw error;
    }
  }

  /**
   * Get current settings value
   */
  getSettings(): CompanySettings {
    return this.settingsSubject.value;
  }

  /**
   * Update settings
   */
  async updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
    try {
      const updated = await this.electron.api.settings.update(updates);
      this.settingsSubject.next(updated);
      
      // Apply language change if updated
      if (updates.language) {
        this.translate.use(updates.language);
      }
      
      return updated;
    } catch (error) {
      console.error('Error updating settings:', error);
      throw error;
    }
  }

  /**
   * Change application language
   */
  async changeLanguage(language: 'de' | 'en'): Promise<void> {
    await this.updateSettings({ language });
  }

  /**
   * Select logo file
   */
  async selectLogo(): Promise<string | null> {
    try {
      const logoPath = await this.electron.api.settings.selectLogo();
      if (logoPath) {
        await this.updateSettings({ logoPath });
      }
      return logoPath;
    } catch (error) {
      console.error('Error selecting logo:', error);
      throw error;
    }
  }

  /**
   * Remove logo
   */
  async removeLogo(): Promise<void> {
    await this.updateSettings({ logoPath: '' });
  }

  /**
   * Get current language
   */
  getCurrentLanguage(): 'de' | 'en' {
    return this.settingsSubject.value.language;
  }
}