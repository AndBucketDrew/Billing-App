import { Injectable, Inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DATA_GATEWAY, DataGateway } from '../data/data-gateway';
import { ConnectionStatusService } from './connection-status.service';
import type { Tour } from '../models/domain.models';

@Injectable({
  providedIn: 'root'
})
export class TourService {
  private toursSubject = new BehaviorSubject<Tour[]>([]);
  public tours$: Observable<Tour[]> = this.toursSubject.asObservable();

  /**
   * True when the last load threw — for ANY reason, not just connectivity. Lets the
   * list distinguish "couldn't load" from "genuinely empty" even on a non-network
   * failure (5xx / RLS), which the connection offline banner does not cover.
   */
  private loadFailedSubject = new BehaviorSubject<boolean>(false);
  public loadFailed$: Observable<boolean> = this.loadFailedSubject.asObservable();

  constructor(
    @Inject(DATA_GATEWAY) private data: DataGateway,
    private connection: ConnectionStatusService,
  ) {
    this.loadTours();
  }

  /**
   * Load all tours from storage
   */
  async loadTours(): Promise<void> {
    try {
      const tours = await this.data.tour.getAll();
      this.toursSubject.next(tours);
      this.loadFailedSubject.next(false);
      this.connection.reportSuccess();
    } catch (error) {
      console.error('Error loading tours:', error);
      this.loadFailedSubject.next(true);
      this.connection.reportError(error);
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
   * Get current tours synchronously (from BehaviorSubject value)
   * Used for meeting point auto-fill logic
   */
  getToursSync(): Tour[] {
    return this.toursSubject.value;
  }

  /**
   * Get tour by ID
   */
  getTourById(id: string): Tour | undefined {
    return this.toursSubject.value.find((t: Tour) => t.id === id);
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
      const newTour = await this.data.tour.create(tourData);
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
      const updated = await this.data.tour.update(id, updates);
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
      const success = await this.data.tour.delete(id);
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