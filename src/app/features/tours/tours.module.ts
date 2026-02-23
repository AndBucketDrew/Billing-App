import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';

import { TourListComponent } from './tour-list.component';
import { TourFormDialogComponent } from './tour-form-dialog/tour-form-dialog.component';

const routes: Routes = [
  {
    path: '',
    component: TourListComponent
  }
];

@NgModule({
  declarations: [
    TourListComponent,
    TourFormDialogComponent
  ],
  imports: [
    SharedModule,
    RouterModule.forChild(routes)
  ]
})
export class ToursModule { }