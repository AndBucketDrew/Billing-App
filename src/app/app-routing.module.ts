import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/dashboard',
    pathMatch: 'full'
  },
  {
    path: 'login',
    loadChildren: () => import('./features/login/login.module').then(m => m.LoginModule)
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadChildren: () => import('./features/dashboard/dashboard.module').then(m => m.DashboardModule)
  },
  {
    path: 'tours',
    canActivate: [authGuard],
    loadChildren: () => import('./features/tours/tours.module').then(m => m.ToursModule)
  },
  {
    path: 'invoices',
    canActivate: [authGuard],
    loadChildren: () => import('./features/invoice-list/invoices.module').then(m => m.InvoicesModule)
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadChildren: () => import('./features/settings/settings.module').then(m => m.SettingsModule)
  },
  {
    path: 'outlook',
    canActivate: [authGuard],
    loadChildren: () => import('./features/outlook-inbox/outlook-inbox.module').then(m => m.OutlookInboxModule)
  },
  {
    path: '**',
    redirectTo: '/login'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }