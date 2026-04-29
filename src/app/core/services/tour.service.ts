import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { API_BASE } from './auth.service';
import { TenantProductDto } from '../models/api.models';
import type { Tour, VatRate } from '../models/domain.models';

@Injectable({
  providedIn: 'root'
})
export class TourService {
  private toursSubject = new BehaviorSubject<Tour[]>([]);
  public tours$: Observable<Tour[]> = this.toursSubject.asObservable();

  constructor(private http: HttpClient) {
    this.loadTours();
  }

  async loadTours(): Promise<void> {
    try {
      const products = await firstValueFrom(
        this.http.get<TenantProductDto[]>(`${API_BASE}/api/BillingProduct`)
      );
      this.toursSubject.next(products.map(p => this.toTour(p)));
    } catch (error) {
      console.error('Error loading products:', error);
      throw error;
    }
  }

  getTours(): Tour[] {
    return this.toursSubject.value;
  }

  getToursSync(): Tour[] {
    return this.toursSubject.value;
  }

  getTourById(id: string): Tour | undefined {
    return this.toursSubject.value.find(t => t.id === id);
  }

  async createTour(tourData: {
    name: string;
    description: string;
    meetingPoint: string;
    basePriceNet: number;
    defaultVatPercentage?: number;
  }): Promise<Tour> {
    try {
      const dto = await firstValueFrom(
        this.http.post<TenantProductDto>(`${API_BASE}/api/BillingProduct`, {
          name: tourData.name,
          description: tourData.description,
          meetingPoint: tourData.meetingPoint,
          basePriceNet: tourData.basePriceNet,
          defaultVatPercentage: tourData.defaultVatPercentage ?? 0
        })
      );
      await this.loadTours();
      return this.toTour(dto);
    } catch (error) {
      console.error('Error creating product:', error);
      throw error;
    }
  }

  async updateTour(id: string, updates: Partial<Tour>): Promise<Tour | null> {
    try {
      const current = this.getTourById(id);
      if (!current) return null;

      const dto = await firstValueFrom(
        this.http.put<TenantProductDto>(`${API_BASE}/api/BillingProduct/${id}`, {
          name: updates.name ?? current.name,
          description: updates.description ?? current.description,
          meetingPoint: updates.meetingPoint ?? current.meetingPoint,
          basePriceNet: updates.basePriceNet ?? current.basePriceNet,
          defaultVatPercentage: (updates as any).defaultVatPercentage ?? current.vatPercentage ?? 0
        })
      );
      await this.loadTours();
      return this.toTour(dto);
    } catch (error) {
      console.error('Error updating product:', error);
      throw error;
    }
  }

  async deleteTour(id: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.delete(`${API_BASE}/api/BillingProduct/${id}`));
      await this.loadTours();
      return true;
    } catch (error) {
      console.error('Error deleting product:', error);
      throw error;
    }
  }

  private toTour(dto: TenantProductDto): Tour {
    return {
      id: dto.id,
      name: dto.name,
      description: dto.description ?? '',
      meetingPoint: dto.meetingPoint ?? '',
      basePriceNet: dto.basePriceNet,
      vatPercentage: dto.defaultVatPercentage as VatRate,
      createdAt: '',
      updatedAt: ''
    };
  }
}
