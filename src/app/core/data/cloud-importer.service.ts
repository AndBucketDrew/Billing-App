import { Injectable } from '@angular/core';
import { ElectronService } from '../services/electron.service';
import { SupabaseService } from '../services/supabase.service';
import * as M from './supabase-mappers';

export interface ImportResult {
  tours: number;
  invoices: number;
}

/**
 * One-time local-JSON -> cloud migration (docs/supabase-saas-plan.md §6).
 *
 * Runs on first authenticated login: if the user's cloud org is still empty and
 * the local Electron store has data, it pushes settings + tours + invoices +
 * line items through the transactional `import_org_data` RPC. Independent of the
 * active DataGateway — it reads via the Electron API and writes via Supabase
 * directly, so it works whether or not the gateway has been flipped yet.
 *
 * The original JSON files are left untouched on disk (never deleted).
 * TODO(phase1): add an IPC to rename them to *.json.imported as a backup marker.
 */
@Injectable({ providedIn: 'root' })
export class CloudImporterService {
  constructor(
    private electron: ElectronService,
    private supabase: SupabaseService,
  ) {}

  /**
   * Imports local data into the cloud if appropriate. Returns the counts on a
   * successful import, or null when nothing was done (not configured, no
   * session, already imported, cloud not empty, or no local data).
   */
  async maybeImport(): Promise<ImportResult | null> {
    const session = this.supabase.session;
    if (!this.supabase.isConfigured || !session) return null;

    // Local data only exists behind Electron IPC. In a browser dev session the
    // Electron API is a mock that returns empty arrays, which would both find
    // "nothing to import" AND set the done-flag — poisoning a later real run.
    // So never touch the flag unless we're actually in the desktop app.
    if (!this.electron.isElectron()) {
      console.info('[import] Not running in Electron — skipping local-JSON import.');
      return null;
    }

    const flagKey = `cloud-import-done:${session.user.id}`;
    if (localStorage.getItem(flagKey)) {
      console.info('[import] Already attempted for this user (flag set) — skipping.');
      return null;
    }

    // Only ever import into an empty cloud org.
    if (!(await this.isCloudEmpty())) {
      console.info('[import] Cloud org already has data — skipping.');
      localStorage.setItem(flagKey, '1');
      return null;
    }

    const [settings, tours, invoices] = await Promise.all([
      this.electron.api.settings.get(),
      this.electron.api.tour.getAll(),
      this.electron.api.invoice.getAll(),
    ]);
    console.info(`[import] Local data found: ${tours.length} tours, ${invoices.length} invoices.`);

    if (tours.length === 0 && invoices.length === 0) {
      console.info('[import] No local tours/invoices to migrate.');
      localStorage.setItem(flagKey, '1'); // nothing worth migrating
      return null;
    }

    const { data, error } = await this.supabase.client.rpc('import_org_data', {
      p_settings: M.settingsToRow(settings),
      p_tours: tours.map(M.tourToImportRow),
      p_invoices: invoices.map(M.invoiceToImportRow),
    });
    if (error) throw error;

    console.info('[import] Done:', data);
    localStorage.setItem(flagKey, '1');
    return data as ImportResult;
  }

  /** True when the caller's org has no tours and no invoices. */
  private async isCloudEmpty(): Promise<boolean> {
    const [tours, invoices] = await Promise.all([
      this.supabase.client.from('tours').select('id', { count: 'exact', head: true }),
      this.supabase.client.from('invoices').select('id', { count: 'exact', head: true }),
    ]);
    if (tours.error) throw tours.error;
    if (invoices.error) throw invoices.error;
    return (tours.count ?? 0) === 0 && (invoices.count ?? 0) === 0;
  }
}
