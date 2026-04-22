import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/dashboard',
    pathMatch: 'full'
  },
  {
    path: 'dashboard',
    loadChildren: () => import('./features/dashboard/dashboard.module').then(m => m.DashboardModule)
  },
  {
    path: 'tours',
    loadChildren: () => import('./features/tours/tours.module').then(m => m.ToursModule)
  },
  {
    path: 'invoices',
    loadChildren: () => import('./features/invoice-list/invoices.module').then(m => m.InvoicesModule)
  },
  {
    path: 'settings',
    loadChildren: () => import('./features/settings/settings.module').then(m => m.SettingsModule)
  },
  {
    path: 'outlook',
    loadChildren: () => import('./features/outlook-inbox/outlook-inbox.module').then(m => m.OutlookInboxModule)
  },
  {
    path: '**',
    redirectTo: '/dashboard'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }