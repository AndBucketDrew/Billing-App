import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InvoiceEditorComponent } from './invoice-editor.component';

describe('InvoiceEditorComponent', () => {
  let component: InvoiceEditorComponent;
  let fixture: ComponentFixture<InvoiceEditorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InvoiceEditorComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(InvoiceEditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
