import { ChangeDetectionStrategy, Component } from '@angular/core';
import { OutlookInboxStore } from '../outlook-inbox.store';

/**
 * Invoice Detection page — the table of detected invoice attachments awaiting
 * review (confirm / reject / choose folder). Reads all state from the shared
 * OutlookInboxStore provided by the shell.
 */
@Component({
  selector: 'app-invoice-detection',
  templateUrl: './invoice-detection.component.html',
  styleUrls: ['./invoice-detection.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvoiceDetectionComponent {
  readonly columns = ['confidence', 'sender', 'subject', 'attachment', 'size', 'receivedAt', 'actions'];

  constructor(readonly store: OutlookInboxStore) {}
}
