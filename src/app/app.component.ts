import { Component, OnInit } from '@angular/core';
import { SettingsService } from './core/services/settings.service';
import { ElectronService } from './core/services/electron.service';
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
  backupWarning: string | null = null;
  updateAvailable: string | null = null;
  updateReady: string | null = null;

  constructor(
    private settingsService: SettingsService,
    private electronService: ElectronService,
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

    // Show a banner if a data file was corrupt and had to be restored from backup
    this.electronService.api.data.on('data:restoredFromBackup', (filename) => {
      this.backupWarning = filename;
    });

    this.electronService.api.update.on('update:available', (version) => {
      this.updateAvailable = version;
    });
    this.electronService.api.update.on('update:downloaded', (version) => {
      this.updateReady = version;
    });
  }

  installUpdate(): void {
    this.electronService.api.update.install();
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