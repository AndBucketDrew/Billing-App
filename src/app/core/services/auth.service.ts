import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { UserAuthDto } from '../models/api.models';

export const API_BASE = 'https://localhost:7000';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private userSubject = new BehaviorSubject<UserAuthDto | null>(null);
  public user$: Observable<UserAuthDto | null> = this.userSubject.asObservable();

  constructor(private http: HttpClient) {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) {
      try {
        this.userSubject.next(JSON.parse(stored));
      } catch {
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(TOKEN_KEY);
      }
    }
  }

  login(userName: string, password: string): Observable<UserAuthDto> {
    return this.http.post<UserAuthDto>(`${API_BASE}/api/user/login`, { userName, password }).pipe(
      tap(user => {
        localStorage.setItem(TOKEN_KEY, user.access_token);
        localStorage.setItem(USER_KEY, JSON.stringify(user));
        this.userSubject.next(user);
      })
    );
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.userSubject.next(null);
  }

  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  isLoggedIn(): boolean {
    return !!this.getToken();
  }

  getUser(): UserAuthDto | null {
    return this.userSubject.value;
  }
}
