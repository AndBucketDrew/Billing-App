import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { OutlookService } from '../../core/services/outlook.service';
import { OutlookSettings } from '../../core/models/outlook.models';

/**
 * Self-contained "Outlook Settings" card embedded on the Settings page. Loads and
 * saves Outlook connection settings directly through OutlookService, independent of
 * the SettingsComponent's reactive company-settings form.
 */
@Component({
  selector: 'app-outlook-settings',
  templateUrl: './outlook-settings.component.html',
  styleUrls: ['./outlook-settings.component.scss'],
  standalone: false,
})
export class OutlookSettingsComponent implements OnInit {
  settings: OutlookSettings | null = null;
  newSenderEmail = '';

  constructor(
    private readonly outlook: OutlookService,
    private readonly snack: MatSnackBar,
    private readonly cd: ChangeDetectorRef,
  ) {}

  async ngOnInit(): Promise<void> {
    this.settings = await this.outlook.getSettings();
    this.cd.markForCheck();
  }

  async saveSettings(): Promise<void> {
    if (!this.settings) return;
    this.settings = await this.outlook.saveSettings(this.settings);
    this.snack.open('Outlook settings saved', undefined, { duration: 2000 });
    this.cd.markForCheck();
  }

  // ── Trusted senders ──────────────────────────────────────────────────────────

  addTrustedSender(email: string): void {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    if (!this.settings) return;
    if (!this.settings.trustedSenders.includes(trimmed)) {
      this.settings.trustedSenders = [...this.settings.trustedSenders, trimmed];
      this.saveTrustedSendersNow();
    }
    this.newSenderEmail = '';
  }

  removeTrustedSender(email: string): void {
    if (!this.settings) return;
    this.settings.trustedSenders = this.settings.trustedSenders.filter(s => s !== email);
    this.saveTrustedSendersNow();
  }

  /**
   * Immediately persists trusted-sender changes so they survive navigation
   * without requiring an explicit "Save Settings" click.
   */
  private saveTrustedSendersNow(): void {
    if (!this.settings) return;
    // Send only trustedSenders — the local settings object already has the new value.
    // Do NOT overwrite this.settings with the server response: that response is built
    // from disk state and would silently discard any other unsaved local changes the
    // user may have made in the settings form (e.g. pollIntervalMinutes, imapHost).
    this.outlook.saveSettings({ trustedSenders: this.settings.trustedSenders })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        this.snack.open(`Failed to save trusted senders: ${msg}`, 'Dismiss', { duration: 4000 });
      });
  }
}
