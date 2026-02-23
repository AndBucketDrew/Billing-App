import { Component, OnInit } from '@angular/core';
import { SettingsService } from '../../../core/services/settings.service';
import { CompanySettings } from '../../../core/models/domain.models';

interface Language {
  code: 'de' | 'en';
  label: string;
  flag: string;
}

@Component({
  selector: 'app-language-switcher',
  templateUrl: './language-switcher.component.html',
  standalone: false,
  styleUrls: ['./language-switcher.component.scss']
})
export class LanguageSwitcherComponent implements OnInit {
  currentLanguage: 'de' | 'en' = 'de';
  
  languages: Language[] = [
    { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
    { code: 'en', label: 'English', flag: '🇬🇧' }
  ];

  constructor(private settingsService: SettingsService) {}

  ngOnInit(): void {
    this.settingsService.settings$.subscribe((settings: CompanySettings) => {
      this.currentLanguage = settings.language;
    });
  }

  async changeLanguage(language: 'de' | 'en'): Promise<void> {
    if (language !== this.currentLanguage) {
      await this.settingsService.changeLanguage(language);
    }
  }

  getCurrentLanguageLabel(): string {
    const lang = this.languages.find(l => l.code === this.currentLanguage);
    return lang ? lang.label : 'Deutsch';
  }

  getCurrentLanguageFlag(): string {
    const lang = this.languages.find(l => l.code === this.currentLanguage);
    return lang ? lang.flag : '🇩🇪';
  }
}