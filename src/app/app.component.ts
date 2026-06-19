import { Component, DestroyRef, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { SettingsService } from './core/services/settings.service';
import { ElectronService } from './core/services/electron.service';
import { Router } from '@angular/router';
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
    private router: Router,
    private destroyRef: DestroyRef
  ) {}

  ngOnInit(): void {
    // React to the settings stream rather than a one-time snapshot: settings load
    // asynchronously at boot, so a snapshot read here could miss the logo path and
    // blank the logo on first paint. This also keeps the logo in sync with changes.
    this.settingsService.settings$
      .pipe(
        map(settings => settings.logoPath),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(logoPath => this.loadLogo(logoPath));

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

  private async loadLogo(logoPath: string | undefined): Promise<void> {
    if (!logoPath) {
      this.logoUrl = null;
      return;
    }

    try {
      const resp = await fetch(logoPath);
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
    this.router.navigate([path]);
  }
}