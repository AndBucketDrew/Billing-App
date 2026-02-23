import { ComponentFixture, TestBed } from '@angular/core/testing';

import { VatSummaryComponent } from './vat-summary.component';

describe('VatSummaryComponent', () => {
  let component: VatSummaryComponent;
  let fixture: ComponentFixture<VatSummaryComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VatSummaryComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(VatSummaryComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
