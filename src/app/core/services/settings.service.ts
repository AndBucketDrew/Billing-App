import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { API_BASE } from './auth.service';
import { ElectronService } from './electron.service';
import { TranslateService } from '@ngx-translate/core';
import { BillingSettingsDto } from '../models/api.models';
import type { CompanySettings } from '../models/domain.models';

const LANG_KEY = 'app_language';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private settingsSubject = new BehaviorSubject<CompanySettings>(this.defaults());
  public settings$: Observable<CompanySettings> = this.settingsSubject.asObservable();

  constructor(
    private http: HttpClient,
    private electron: ElectronService,
    private translate: TranslateService
  ) {
    this.loadSettings();
  }

  async loadSettings(): Promise<void> {
    try {
      const dto = await firstValueFrom(
        this.http.get<BillingSettingsDto>(`${API_BASE}/api/BillingSettings`)
      );
      const language = (localStorage.getItem(LANG_KEY) as 'de' | 'en') ?? 'de';
      const settings = this.toCompanySettings(dto, language);
      this.settingsSubject.next(settings);
      this.translate.use(language);
    } catch (error) {
      console.error('Error loading billing settings:', error);
      throw error;
    }
  }

  getSettings(): CompanySettings {
    return this.settingsSubject.value;
  }

  async updateSettings(updates: Partial<CompanySettings>): Promise<CompanySettings> {
    try {
      const current = this.settingsSubject.value;
      const merged = { ...current, ...updates };

      const dto = await firstValueFrom(
        this.http.put<BillingSettingsDto>(`${API_BASE}/api/BillingSettings`, {
          companyAddress: merged.companyAddress,
          cityCountry: merged.cityCountry,
          vatNumber: merged.vatNumber,
          logoPath: merged.logoPath,
          defaultVatPercentage: merged.defaultVatPercentage,
          bankName: merged.bankName,
          accountHolder: merged.accountHolder,
          iban: merged.iban,
          bic: merged.bic,
          registrationNumber: merged.registrationNumber
        })
      );

      const language = updates.language ?? current.language;
      if (updates.language) {
        localStorage.setItem(LANG_KEY, updates.language);
        this.translate.use(updates.language);
      }

      const newSettings = this.toCompanySettings(dto, language);
      this.settingsSubject.next(newSettings);
      return newSettings;
    } catch (error) {
      console.error('Error updating billing settings:', error);
      throw error;
    }
  }

  async changeLanguage(language: 'de' | 'en'): Promise<void> {
    await this.updateSettings({ language });
  }

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

  async removeLogo(): Promise<void> {
    await this.updateSettings({ logoPath: '' });
  }

  getCurrentLanguage(): 'de' | 'en' {
    return this.settingsSubject.value.language;
  }

  private toCompanySettings(dto: BillingSettingsDto, language: 'de' | 'en'): CompanySettings {
    return {
      language,
      invoiceCounter: 1,
      companyName: dto.companyName ?? '',
      companyAddress: dto.companyAddress ?? '',
      cityCountry: dto.cityCountry ?? '',
      vatNumber: dto.vatNumber ?? '',
      logoPath: dto.logoPath ?? '',
      defaultVatPercentage: dto.defaultVatPercentage as any,
      bankName: dto.bankName ?? '',
      accountHolder: dto.accountHolder ?? '',
      iban: dto.iban ?? '',
      bic: dto.bic ?? '',
      legalForm: '',
      headquarters: '',
      courtRegistry: '',
      registrationNumber: dto.registrationNumber ?? '',
      invoiceFooterText: ''
    };
  }

  private defaults(): CompanySettings {
    return {
      language: 'de',
      invoiceCounter: 1,
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
    };
  }
}
