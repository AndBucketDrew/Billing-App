import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LineItemsTableComponent } from './line-items-table.component';

describe('LineItemsTableComponent', () => {
  let component: LineItemsTableComponent;
  let fixture: ComponentFixture<LineItemsTableComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LineItemsTableComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LineItemsTableComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
