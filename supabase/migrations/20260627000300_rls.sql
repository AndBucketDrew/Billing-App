-- ============================================================================
-- Row-Level Security. See docs/supabase-saas-plan.md §4 (Integrity rules).
-- Rule: a user may touch a row only if its organization_id is one of their
-- memberships. service_role (Edge Functions) bypasses RLS entirely.
--
-- NOTE: entitlement gating (INSERT on invoices/tours requires an ACTIVE
-- subscription) is Phase 2 — it will REPLACE the broad insert path below once
-- the subscriptions table exists. For Phase 1, membership is the only gate.
-- ============================================================================

alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.tours                 enable row level security;
alter table public.invoices              enable row level security;
alter table public.invoice_line_items    enable row level security;
alter table public.company_settings      enable row level security;

-- Base privileges (RLS still filters rows). Org/membership/settings rows are
-- created by the SECURITY DEFINER signup trigger, so clients get no INSERT there.
grant usage on schema public to authenticated;
grant select, update                  on public.organizations        to authenticated;
grant select                          on public.organization_members to authenticated;
grant select, insert, update, delete  on public.tours                to authenticated;
grant select, insert, update, delete  on public.invoices             to authenticated;
grant select, insert, update, delete  on public.invoice_line_items   to authenticated;
grant select, update                  on public.company_settings     to authenticated;

-- ── organizations ───────────────────────────────────────────────────────────
create policy organizations_select on public.organizations
  for select using (public.is_org_member(id));
create policy organizations_update on public.organizations
  for update using (public.is_org_member(id)) with check (public.is_org_member(id));

-- ── organization_members ─────────────────────────────────────────────────────
create policy organization_members_select on public.organization_members
  for select using (user_id = auth.uid() or public.is_org_member(org_id));

-- ── tours ─────────────────────────────────────────────────────────────────────
create policy tours_all on public.tours
  for all
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- ── invoices ───────────────────────────────────────────────────────────────────
-- Membership-scoped CRUD. The immutability trigger (next migration) is what
-- protects finalized/storniert rows from edits — RLS only enforces tenancy.
create policy invoices_all on public.invoices
  for all
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

-- ── invoice_line_items ─────────────────────────────────────────────────────────
-- Reachable only through an invoice the user can access.
create policy invoice_line_items_all on public.invoice_line_items
  for all
  using (exists (
    select 1 from public.invoices i
    where i.id = invoice_id and public.is_org_member(i.organization_id)
  ))
  with check (exists (
    select 1 from public.invoices i
    where i.id = invoice_id and public.is_org_member(i.organization_id)
  ));

-- ── company_settings ───────────────────────────────────────────────────────────
create policy company_settings_select on public.company_settings
  for select using (public.is_org_member(organization_id));
create policy company_settings_update on public.company_settings
  for update using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
