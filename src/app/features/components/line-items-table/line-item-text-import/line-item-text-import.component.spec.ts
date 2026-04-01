import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LineItemTextImport } from './line-item-text-import.component';

describe('LineItemTextImport', () => {
  let component: LineItemTextImport;
  let fixture: ComponentFixture<LineItemTextImport>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LineItemTextImport]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LineItemTextImport);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
