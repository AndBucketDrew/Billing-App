import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TourFormDialogComponent } from './tour-form-dialog.component';

describe('TourFormDialogComponent', () => {
  let component: TourFormDialogComponent;
  let fixture: ComponentFixture<TourFormDialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TourFormDialogComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TourFormDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
