import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { OutlookInboxComponent } from './outlook-inbox.component';

const routes: Routes = [
  { path: '', component: OutlookInboxComponent }
];

@NgModule({
  declarations: [OutlookInboxComponent],
  imports: [
    SharedModule,
    RouterModule.forChild(routes),
  ],
})
export class OutlookInboxModule {}
