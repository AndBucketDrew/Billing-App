# Supabase backend (SaaS migration)

Phase 1 schema for the cloud pivot. See [`docs/supabase-saas-plan.md`](../docs/supabase-saas-plan.md).

## Migrations (apply in filename order)

| File | What it does |
|---|---|
| `20260627000100_schema.sql` | Tables: organizations, organization_members, tours, invoices, invoice_line_items, company_settings |
| `20260627000200_tenancy.sql` | `is_org_member()`, `current_org_id()`, and the signup trigger that auto-creates org + owner membership + settings row |
| `20260627000300_rls.sql` | Row-Level Security (tenancy isolation) + base grants |
| `20260627000400_immutability.sql` | Column-level immutability for finalized/storniert invoices (allows `is_paid` + `finalized→storniert`) |
| `20260627000500_rpcs.sql` | `create_invoice`, `update_invoice`, `finalize_invoice`, `create_credit_note`, `invoice_json` |
| `20260627000600_import.sql` | `import_org_data` — one-time local-JSON → cloud migration (transactional) |
| `20260627000700_timestamps.sql` | `updated_at` touch triggers (server-authoritative timestamps) on tours/invoices/company_settings |

## Local dev / verification

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli) + Docker.

```bash
# one-time, in the repo root (won't overwrite existing migrations):
supabase init

# start a local stack and apply every migration from scratch:
supabase start
supabase db reset
```

The migrations are intentionally **not yet linked to a cloud project** — Phase 0
(create the EU/Frankfurt project) is still pending. Once it exists:

```bash
supabase link --project-ref <ref>
supabase db push
```

## Applying to an already-provisioned project

`phase1_all.sql` is the **fresh-project** bundle (its `create table` / `create policy`
statements are not idempotent — re-running on an existing project errors on the first
table). When the schema is already applied and you only need the code-review fixes on
top, paste **`apply_review_fixes.sql`** into the SQL Editor instead — it is idempotent
(`create or replace` functions, `drop … if exists` + `create` triggers) and re-defines
only the changed objects (immutability tour-FK exemption, `update_invoice`,
`create_credit_note`/`finalize_invoice` hardening, `updated_at` touch triggers).

## Verification (pgTAP — see plan §9)

pgTAP tests live in `supabase/tests/` and cover the four Phase 1 invariants:

| File | Covers |
|---|---|
| `01_rls_isolation_test.sql` | RLS tenancy — two orgs cannot see or write each other's rows |
| `02_immutability_test.sql` | Finalized/storniert header + line items frozen; `is_paid` toggle, `finalized→storniert`, and the tour FK set-null exemption still allowed |
| `03_finalize_counter_test.sql` | Sequential numbers (NNN), counter bump, idempotent re-finalize, year rollover, duplicate-number index |
| `04_credit_note_test.sql` | `create_credit_note` forces type/draft, flips original to storniert, number-match guard, draft cascade delete |
| `05_forgery_prevention_test.sql` | A direct `authenticated` write cannot mint a finalized/numbered invoice or escalate a draft's status; `finalize_invoice` discards a client-set number on a regular invoice and allocates from the counter |

Run them against a local stack (needs the [Supabase CLI](https://supabase.com/docs/guides/cli) + Docker).
The first four files (32 subtests) passed as of 2026-06-30; `05_forgery_prevention_test.sql`
(5 subtests) was added with the review fixes — re-run `supabase test db` to confirm the full suite.

```bash
supabase init                 # one-time, if not already initialised
supabase start                # applies every migration; first run pulls images
supabase test db              # runs supabase/tests/*.sql (pgTAP via the pg_prove image)
```

**Harness note:** each test provisions tenants as the superuser (to fire the
signup trigger), then `set role authenticated` once so RLS actually applies and
pgTAP's temp bookkeeping is owned by `authenticated`. Tenants A/B are
impersonated by swapping only `request.jwt.claims.sub`.

**Not covered (single-session limit):** true *parallel* `finalize_invoice` (the
`FOR UPDATE` race) needs two concurrent sessions; pgTAP pins the counter +
partial-unique-index invariants that make a duplicate impossible even if the lock
were lost. A concurrency smoke test would need a separate two-connection script.

## Not in Phase 1 (deferred)

- `subscriptions` / `payment_events` tables, Supabase Vault, MyPOS Edge Functions (Phase 2).
- **Entitlement gating**: the broad invoice/tour INSERT policies in `..._rls.sql`
  will be tightened in Phase 2 so INSERT requires an `active` subscription.
