import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService } from './electron.service';
import type { Tour, VatRate } from '../models/domain.models';

@Injectable({
  providedIn: 'root'
})
export class TourService {
  private toursSubject = new BehaviorSubject<Tour[]>([]);
  public tours$: Observable<Tour[]> = this.toursSubject.asObservable();

  constructor(private electron: ElectronService) {
    this.loadTours();
  }

  /**
   * Load all tours from storage
   */
  async loadTours(): Promise<void> {
    try {
      const tours = await this.electron.api.tour.getAll();
      this.toursSubject.next(tours);
    } catch (error) {
      console.error('Error loading tours:', error);
      throw error;
    }
  }

  /**
   * Get current tours value
   */
  getTours(): Tour[] {
    return this.toursSubject.value;
  }

  /**
   * Get tour by ID
   */
  getTourById(id: string): Tour | undefined {
    return this.toursSubject.value.find(t => t.id === id);
  }

  /**
   * Create a new tour
   */
  async createTour(tourData: {
    name: string;
    description: string;
    meetingPoint: string;
    basePriceNet: number;
  }): Promise<Tour> {
    try {
      const newTour = await this.electron.api.tour.create(tourData);
      await this.loadTours(); // Refresh list
      return newTour;
    } catch (error) {
      console.error('Error creating tour:', error);
      throw error;
    }
  }

  /**
   * Update an existing tour
   */
  async updateTour(id: string, updates: Partial<Tour>): Promise<Tour | null> {
    try {
      const updated = await this.electron.api.tour.update(id, updates);
      if (updated) {
        await this.loadTours(); // Refresh list
      }
      return updated;
    } catch (error) {
      console.error('Error updating tour:', error);
      throw error;
    }
  }

  /**
   * Delete a tour
   */
  async deleteTour(id: string): Promise<boolean> {
    try {
      const success = await this.electron.api.tour.delete(id);
      if (success) {
        await this.loadTours(); // Refresh list
      }
      return success;
    } catch (error) {
      console.error('Error deleting tour:', error);
      throw error;
    }
  }
}