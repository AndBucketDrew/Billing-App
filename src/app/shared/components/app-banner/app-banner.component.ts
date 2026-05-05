import { Component, Input, Output, EventEmitter } from '@angular/core';

@Component({
  selector: 'app-banner',
  templateUrl: './app-banner.component.html',
  styleUrls: ['./app-banner.component.scss'],
  standalone: false
})
export class AppBannerComponent {
  @Input() icon = 'info_outline';
  @Input() type: 'warning' | 'error' = 'warning';
  @Output() dismissed = new EventEmitter<void>();
}
