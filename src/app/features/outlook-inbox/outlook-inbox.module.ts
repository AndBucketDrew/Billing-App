import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { OutlookShellComponent } from './outlook-shell.component';
import { InvoiceDetectionComponent } from './pages/invoice-detection.component';
import { PdfParserComponent } from './pages/pdf-parser.component';
import { ExportConfirmDialogComponent } from './export-confirm-dialog.component';
import { EditConfirmDialogComponent } from './edit-confirm-dialog.component';

const routes: Routes = [
  {
    path: '',
    component: OutlookShellComponent,
    children: [
      { path: '', redirectTo: 'detection', pathMatch: 'full' },
      { path: 'detection', component: InvoiceDetectionComponent },
      { path: 'parser', component: PdfParserComponent },
    ],
  },
];

@NgModule({
  declarations: [
    OutlookShellComponent,
    InvoiceDetectionComponent,
    PdfParserComponent,
    ExportConfirmDialogComponent,
    EditConfirmDialogComponent,
  ],
  imports: [
    SharedModule,
    RouterModule.forChild(routes),
  ],
})
export class OutlookInboxModule {}
