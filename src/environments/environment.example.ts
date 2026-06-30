// Template for the local environment files (which are git-ignored).
//
// Setup: copy this file to BOTH
//   - src/environments/environment.ts             (production build)
//   - src/environments/environment.development.ts (ng serve / --configuration development)
// and fill in your Supabase project's values.
//
// The anon key is PUBLIC and safe to ship — RLS protects the data
// (see docs/supabase-saas-plan.md §2.6). The service_role key and MyPOS RSA
// private key must NEVER appear here; they live only in Edge Functions / Vault.
// Leaving the values empty disables the cloud backend (the app stays on the
// local Electron backend).
export const environment = {
  production: true, // set to false in environment.development.ts
  supabaseUrl: '',
  supabaseAnonKey: '',
};
