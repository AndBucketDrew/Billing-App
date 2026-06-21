import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { OutlookInboxStore } from './outlook-inbox.store';

/**
 * Shell for the Outlook feature: owns the connection header, status bar and the
 * sub-navigation, then renders the active child page (Invoice Detection / PDF Parser)
 * in its <router-outlet>.
 *
 * Provides OutlookInboxStore here so the store's lifetime is bound to this component:
 * created on entering /outlook, destroyed on leaving. The child pages inject the same
 * instance through the element-injector hierarchy.
 */
@Component({
  selector: 'app-outlook-shell',
  templateUrl: './outlook-shell.component.html',
  styleUrls: ['./outlook-shell.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [OutlookInboxStore],
})
export class OutlookShellComponent implements OnInit {
  constructor(readonly store: OutlookInboxStore) {}

  ngOnInit(): void {
    void this.store.init();
  }
}
