import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';

import { InvoiceListComponent } from '../invoice-list/invoice-list.component';
import { InvoiceEditorComponent } from './invoice-editor/invoice-editor.component';
import { LineItemsTableComponent } from '../components/line-items-table/line-items-table.component';
import { VatSummaryComponent } from '../components/vat-summary/vat-summary.component';
import { TourSelectorDialogComponent } from '../components/tour-selector-dialog/tour-selector-dialog.component';
import { LineItemTextImport } from '../components/line-items-table/line-item-text-import/line-item-text-import.component';

const routes: Routes = [
  {
    path: '',
    component: InvoiceListComponent
  },
  {
    path: 'create',
    component: InvoiceEditorComponent
  },
  {
    path: 'edit/:id',
    component: InvoiceEditorComponent
  }
];

@NgModule({
  declarations: [
    InvoiceListComponent,
    InvoiceEditorComponent,
    LineItemsTableComponent,
    VatSummaryComponent,
    TourSelectorDialogComponent,
    LineItemTextImport

  ],
  imports: [
    SharedModule,
    RouterModule.forChild(routes)
  ]
})
export class InvoicesModule { }