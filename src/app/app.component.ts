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

  constructor(
    private settingsService: SettingsService,
    private router: Router
  ) {
    // Debug routing
    this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) {
        console.log('Navigated to:', event.url);
      }
    });
  }

  ngOnInit(): void {
    console.log('App initialized');
    console.log('Current route:', this.router.url);
    // Settings service will automatically load and apply language
  }

  onNavigate(path: string): void {
    console.log('Navigating to:', path);
    this.router.navigate([path]);
  }
}