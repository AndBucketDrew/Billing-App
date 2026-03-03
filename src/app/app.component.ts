import { Component, OnInit } from '@angular/core';
import { SettingsService } from './core/services/settings.service';
import { Router, NavigationEnd } from '@angular/router';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { SharedModule } from './shared/shared.module';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  imports: [
    CommonModule,
    SharedModule,
    RouterOutlet,
    TranslateModule
  ],
  styleUrls: ['./app.component.scss'],
})
export class AppComponent implements OnInit {
  title = 'Tour Billing';
  logoUrl: string | null = null;

  constructor(
    private settingsService: SettingsService,
    private router: Router
  ) {
    this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) {
        console.log('Navigated to:', event.url);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    console.log('App initialized');
    console.log('Current route:', this.router.url);
    await this.loadLogo();
  }

  private async loadLogo(): Promise<void> {
    const settings = this.settingsService.getSettings();

    if (!settings.logoPath) return;

    try {
      const resp = await fetch(settings.logoPath);
      if (!resp.ok) return;

      const blob = await resp.blob();
      this.logoUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn('Could not load logo:', err);
      this.logoUrl = null;
    }
  }

  onNavigate(path: string): void {
    console.log('Navigating to:', path);
    this.router.navigate([path]);
  }
}