import { Component, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SharedModule } from '../../shared/shared.module';
import { AuthService } from '../../core/services/auth.service';

type Mode = 'signin' | 'signup';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [SharedModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss'],
})
export class LoginComponent {
  mode: Mode = 'signin';
  loading = false;
  error: string | null = null;
  info: string | null = null;

  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(6)]],
  });

  setMode(mode: Mode): void {
    this.mode = mode;
    this.error = null;
    this.info = null;
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.loading) {
      this.form.markAllAsTouched();
      return;
    }

    this.loading = true;
    this.error = null;
    this.info = null;

    const { email, password } = this.form.getRawValue();
    const result =
      this.mode === 'signin'
        ? await this.auth.signIn(email, password)
        : await this.auth.signUp(email, password);

    this.loading = false;

    if (!result.success) {
      this.error = result.error ?? 'Something went wrong.';
      return;
    }

    if (result.needsEmailConfirmation) {
      this.setMode('signin');
      this.info = 'Account created — check your inbox to confirm your email, then sign in.';
      return;
    }

    const redirect = this.route.snapshot.queryParamMap.get('redirect') || '/dashboard';
    this.router.navigateByUrl(redirect);
  }
}
