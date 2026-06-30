import { Injectable } from '@angular/core';
import { ElectronService } from '../services/electron.service';
import type { DataGateway, TourGateway, InvoiceGateway, SettingsGateway } from './data-gateway';

/**
 * Current ({@link DataGateway}) implementation: delegates straight to the Electron
 * IPC bridge. This preserves today's local-JSON behavior exactly. The Supabase
 * migration adds a parallel implementation behind the same DATA_GATEWAY token.
 */
@Injectable({ providedIn: 'root' })
export class ElectronDataGateway implements DataGateway {
  constructor(private electron: ElectronService) {}

  get tour(): TourGateway {
    return this.electron.api.tour;
  }

  get invoice(): InvoiceGateway {
    return this.electron.api.invoice;
  }

  get settings(): SettingsGateway {
    return this.electron.api.settings;
  }
}
