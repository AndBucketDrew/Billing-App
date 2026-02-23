import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TourSelectorDialogComponent } from './tour-selector-dialog.component';

describe('TourSelectorDialogComponent', () => {
  let component: TourSelectorDialogComponent;
  let fixture: ComponentFixture<TourSelectorDialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TourSelectorDialogComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TourSelectorDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
