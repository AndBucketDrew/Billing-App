import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, map, filter } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { SettingsService } from './core/services/settings.service';
import { TourService } from './core/services/tour.service';
import { InvoiceService } from './core/services/invoice.service';
import { ElectronService } from './core/services/electron.service';
import { AuthService } from './core/services/auth.service';
import { SupabaseService } from './core/services/supabase.service';
import { ConnectionStatusService } from './core/services/connection-status.service';
import { CloudImporterService } from './core/data/cloud-importer.service';
import { NavigationEnd, Router } from '@angular/router';
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

  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseService);
  private readonly importer = inject(CloudImporterService);
  private readonly connection = inject(ConnectionStatusService);

  /** Cloud reads are currently failing (offline / backend unreachable). */
  connectionOffline = false;
  /** User dismissed the offline banner; reset on the next fresh failure. */
  private connectionBannerDismissed = false;

  /** Show the offline banner only when cloud is active and not dismissed. */
  get showConnectionBanner(): boolean {
    return this.cloudEnabled && this.connectionOffline && !this.connectionBannerDismissed;
  }

  dismissConnectionBanner(): void {
    this.connectionBannerDismissed = true;
  }

  /** Hide the app chrome (toolbar) on full-screen routes like /login. */
  hideChrome = false;
  /** Shown once after a successful local-JSON -> cloud migration. */
  importNotice: string | null = null;
  /** Shown if the migration attempt failed. */
  importError: string | null = null;
  /** Whether to surface the sign-out control (cloud configured + signed in). */
  readonly isAuthenticated$: Observable<boolean> = this.auth.isAuthenticated$;
  readonly cloudEnabled = this.supabase.isConfigured;

  constructor(
    private settingsService: SettingsService,
    private tourService: TourService,
    private invoiceService: InvoiceService,
    private electronService: ElectronService,
    private router: Router,
    private destroyRef: DestroyRef
  ) {}

  ngOnInit(): void {
    this.hideChrome = this.router.url.startsWith('/login');
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(e => (this.hideChrome = e.urlAfterRedirects.startsWith('/login')));

    // When a session appears: run the one-time migration (no-op after the first
    // time), then (re)load cloud data so it shows immediately after sign-in.
    // SettingsService boots pre-auth with defaults, so this reload is what fills
    // it in once authenticated.
    this.auth.session$
      .pipe(
        map(s => s?.user?.id ?? null),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(userId => { if (userId) this.onSignedIn(); });

    // Surface a clear "cloud unreachable" banner when reads start failing; a fresh
    // failure re-shows it even after a previous dismissal.
    this.connection.offline$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(offline => {
        this.connectionOffline = offline;
        if (offline) this.connectionBannerDismissed = false;
      });

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

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.router.navigateByUrl('/login');
  }

  private async onSignedIn(): Promise<void> {
    await this.runImport();
    // Refresh all cloud-backed stores now that we have a session.
    await this.reloadAll();
  }

  /**
   * Re-fetch every cloud-backed store (used post-login and by the offline Retry).
   * Uses allSettled so one failing read doesn't abort the others — each service
   * reports its own success/failure to ConnectionStatusService, so we want them all
   * to run and the final offline state to reflect every store, not just whichever
   * one happened to reject first.
   */
  private async reloadAll(): Promise<void> {
    const results = await Promise.allSettled([
      this.settingsService.loadSettings(),
      this.tourService.loadTours(),
      this.invoiceService.loadInvoices(),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') console.error('Cloud data reload failed:', r.reason);
    }
  }

  /** Retry the failed cloud reads; the services update the offline state on outcome. */
  async retryConnection(): Promise<void> {
    await this.reloadAll();
  }

  private async runImport(): Promise<void> {
    try {
      const result = await this.importer.maybeImport();
      if (result && (result.tours > 0 || result.invoices > 0)) {
        this.importNotice = `Imported ${result.tours} tour(s) and ${result.invoices} invoice(s) to your cloud account.`;
      }
    } catch (err: any) {
      console.error('Cloud import failed:', err);
      this.importError = `Cloud import failed: ${err?.message ?? err}`;
    }
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