import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/tours',
    pathMatch: 'full'
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
    path: '**',
    redirectTo: '/tours'
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }