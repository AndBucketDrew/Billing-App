-- ============================================================================
-- Phase 1 — paste-and-run bundle for the Supabase SQL Editor.
-- Concatenation of supabase/migrations/*.sql in order. Run ONCE on a fresh
-- project. For repeatable/local workflows use the individual migrations with
-- the Supabase CLI instead. Generated 2026-06-30 (regenerated after review fixes).
-- ============================================================================

-- >>> 20260627000100_schema.sql >>>
-- ============================================================================
-- Phase 1 schema — multi-tenant port of the local JSON model.
-- See docs/supabase-saas-plan.md §4. Column names are snake_case (Postgres
-- convention); the Angular SupabaseDataGateway maps them to/from the camelCase
-- domain shapes in src/app/core/models/domain.models.ts.
--
-- Money is numeric(12,2). invoice_date / tour_date are TEXT on purpose: an
-- invoice is a legal *snapshot*, so we store the exact string the client froze,
-- never a tz-coerced timestamp.
-- ============================================================================

-- ── Tenancy ─────────────────────────────────────────────────────────────────

create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  created_at timestamptz not null default now()
);

create table public.organization_members (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index organization_members_user_idx on public.organization_members(user_id);

-- ── Business data ───────────────────────────────────────────────────────────

create table public.tours (
  id              text primary key default gen_random_uuid()::text,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null default '',
  description     text not null default '',
  meeting_point   text not null default '',
  base_price_net  numeric(12,2) not null default 0,
  vat_percentage  smallint check (vat_percentage in (0, 10, 13, 20)),  -- nullable: set per invoice
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index tours_org_idx on public.tours(organization_id);

create table public.invoices (
  id                              text primary key default gen_random_uuid()::text,
  organization_id                 uuid not null references public.organizations(id) on delete cascade,
  invoice_number                  text,                       -- null while draft; assigned at finalize
  invoice_date                    text not null,
  salutation                      text,
  customer_name                   text not null default '',
  customer_address                text not null default '',
  customer_email                  text,
  -- company billing details (denormalized snapshot — never a live join)
  company_name                    text,
  company_address                 text,
  company_city_country            text,
  company_tax_id                  text,
  company_customer_name           text,
  purchase_order_number           text,
  -- tour details
  tour_date                       text,
  meeting_point                   text,
  pax                             integer,
  guide                           text,
  civitatis_id                    text,
  payment_method                  text check (payment_method in ('bank', 'paypal', 'cash', 'civitatis', 'mypos')),
  -- classification
  type                            text check (type in ('invoice', 'credit_note')),
  credit_note_for_invoice_number  text,
  is_paid                         boolean,
  language                        text not null default 'de' check (language in ('de', 'en')),
  status                          text not null default 'draft' check (status in ('draft', 'finalized', 'storniert')),
  -- frozen totals (vat_breakdown is DERIVED on read — never stored)
  total_net                       numeric(12,2) not null default 0,
  total_vat                       numeric(12,2) not null default 0,
  total_gross                     numeric(12,2) not null default 0,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);
create index invoices_org_idx on public.invoices(organization_id);

-- A finalized number is unique per org; drafts (null number) are exempt.
create unique index invoices_org_number_uq
  on public.invoices(organization_id, invoice_number)
  where invoice_number is not null;

create table public.invoice_line_items (
  id               text primary key default gen_random_uuid()::text,
  invoice_id       text not null references public.invoices(id) on delete cascade,
  tour_id          text references public.tours(id) on delete set null,
  description      text not null default '',
  quantity         numeric(12,2) not null default 0,   -- negative on credit notes
  unit_price_net   numeric(12,2) not null default 0,
  vat_percentage   smallint not null default 0 check (vat_percentage in (0, 10, 13, 20)),
  line_total_net   numeric(12,2) not null default 0,
  line_total_vat   numeric(12,2) not null default 0,
  line_total_gross numeric(12,2) not null default 0,
  sort_order       integer not null default 0
);
create index invoice_line_items_invoice_idx on public.invoice_line_items(invoice_id);

-- One settings row per organization (incl. the per-tenant invoice counter).
create table public.company_settings (
  organization_id        uuid primary key references public.organizations(id) on delete cascade,
  language               text not null default 'de' check (language in ('de', 'en')),
  invoice_counter        integer not null default 1,
  invoice_counter_year   integer,
  company_name           text not null default '',
  company_address        text not null default '',
  city_country           text not null default '',
  vat_number             text not null default '',
  logo_path              text,
  default_vat_percentage smallint not null default 13 check (default_vat_percentage in (0, 10, 13, 20)),
  bank_name              text not null default '',
  account_holder         text not null default '',
  iban                   text not null default '',
  bic                    text not null default '',
  legal_form             text not null default '',
  headquarters           text not null default '',
  court_registry         text not null default '',
  registration_number    text not null default '',
  brand_color            text,
  invoice_footer_text    text not null default '',
  email_subject_de       text,
  email_subject_en       text,
  email_body_de          text,
  email_body_en          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- >>> 20260627000200_tenancy.sql >>>
-- ============================================================================
-- Tenancy helpers + auto-provisioning on signup.
-- See docs/supabase-saas-plan.md §4 (Tenancy). 1 user = 1 org to start; the
-- membership table already supports multiple members per org later.
-- ============================================================================

-- Is the current user a member of the given org?  SECURITY DEFINER so it reads
-- organization_members WITHOUT triggering that table's own RLS (avoids the
-- classic policy-recursion problem). Used by every RLS policy and RPC below.
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
  );
$$;

-- The current user's org. Single-membership assumption for Phase 1; when
-- multi-org lands, RPCs take an explicit org_id instead of calling this.
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.org_id
  from public.organization_members m
  where m.user_id = auth.uid()
  order by m.created_at
  limit 1;
$$;

-- On signup: create the org, the owner membership, and an empty settings row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  insert into public.organizations (name) values ('') returning id into v_org_id;
  insert into public.organization_members (org_id, user_id, role) values (v_org_id, new.id, 'owner');
  insert into public.company_settings (organization_id) values (v_org_id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

grant execute on function public.is_org_member(uuid)  to authenticated;
grant execute on function public.current_org_id()      to authenticated;

-- >>> 20260627000300_rls.sql >>>
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

-- >>> 20260627000400_immutability.sql >>>
-- ============================================================================
-- Legal immutability for finalized / storniert invoices.
-- See docs/supabase-saas-plan.md §4 (Integrity rules).
--
-- This is NOT a blanket UPDATE lock: the app legitimately toggles is_paid on
-- finalized invoices (InvoiceService.togglePaid), and create_credit_note must
-- flip a finalized original to 'storniert'. So we lock the FINANCIAL/LEGAL
-- columns and the number, while allowing:
--   • is_paid changes,
--   • updated_at bumps,
--   • the one-way status transition finalized -> storniert.
-- DELETE of a finalized/storniert invoice is forbidden outright.
-- ============================================================================

create or replace function public.enforce_invoice_immutability()
returns trigger
language plpgsql
as $$
begin
  -- Numbering and finalization are owned exclusively by the SECURITY DEFINER RPCs
  -- (create_invoice / finalize_invoice / create_credit_note), which run as the
  -- function owner. A direct PostgREST write runs as 'authenticated'. Block that
  -- role from minting a finalized/numbered invoice out of band — otherwise a
  -- crafted request could forge an invoice number, skipping the org counter and
  -- the legal sequential-numbering guarantee. (RLS still scopes everything to the
  -- caller's own org; this only closes the same-tenant forge path.)
  if tg_op = 'INSERT' then
    if current_user = 'authenticated'
       and (new.status is distinct from 'draft' or new.invoice_number is not null) then
      raise exception 'Direct creation of a numbered/finalized invoice is not allowed; use create_invoice / create_credit_note'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status in ('finalized', 'storniert') then
      raise exception 'Cannot delete a % invoice (legal record)', old.status
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- UPDATE on a draft: header/line-item edits are free, but a direct client may not
  -- transition the status (draft -> finalized/storniert) — that path belongs to the
  -- RPCs, which assign the number atomically under the counter lock.
  if old.status not in ('finalized', 'storniert') then
    if current_user = 'authenticated'
       and new.status is distinct from old.status then
      raise exception 'Direct status change is not allowed; use finalize_invoice / create_credit_note'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Locked columns on a finalized/storniert invoice.
  if (new.invoice_number                 is distinct from old.invoice_number)
   or (new.invoice_date                  is distinct from old.invoice_date)
   or (new.organization_id               is distinct from old.organization_id)
   or (new.salutation                    is distinct from old.salutation)
   or (new.customer_name                 is distinct from old.customer_name)
   or (new.customer_address              is distinct from old.customer_address)
   or (new.customer_email                is distinct from old.customer_email)
   or (new.company_name                  is distinct from old.company_name)
   or (new.company_address               is distinct from old.company_address)
   or (new.company_city_country          is distinct from old.company_city_country)
   or (new.company_tax_id                is distinct from old.company_tax_id)
   or (new.company_customer_name         is distinct from old.company_customer_name)
   or (new.purchase_order_number         is distinct from old.purchase_order_number)
   or (new.tour_date                     is distinct from old.tour_date)
   or (new.meeting_point                 is distinct from old.meeting_point)
   or (new.pax                           is distinct from old.pax)
   or (new.guide                         is distinct from old.guide)
   or (new.civitatis_id                  is distinct from old.civitatis_id)
   or (new.payment_method                is distinct from old.payment_method)
   or (new.type                          is distinct from old.type)
   or (new.credit_note_for_invoice_number is distinct from old.credit_note_for_invoice_number)
   or (new.language                      is distinct from old.language)
   or (new.total_net                     is distinct from old.total_net)
   or (new.total_vat                     is distinct from old.total_vat)
   or (new.total_gross                   is distinct from old.total_gross)
   or (new.created_at                    is distinct from old.created_at)
  then
    raise exception 'Cannot modify financial fields of a % invoice', old.status
      using errcode = 'check_violation';
  end if;

  -- status may only move finalized -> storniert.
  if new.status is distinct from old.status
     and not (old.status = 'finalized' and new.status = 'storniert')
  then
    raise exception 'Invalid invoice status transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_invoice_immutability
  before insert or update or delete on public.invoices
  for each row execute function public.enforce_invoice_immutability();

-- Line items of a finalized/storniert invoice are frozen too. (A draft being
-- deleted cascades to its line items while still a draft, so that path is fine;
-- a finalized invoice can't be deleted at all, per the trigger above.)
create or replace function public.enforce_line_item_immutability()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  -- Exemption: the tours FK is `on delete set null`, so deleting a tour fires an
  -- UPDATE that nulls tour_id on its line items. That UPDATE must succeed even
  -- when the line item belongs to a finalized/storniert invoice — clearing a
  -- dangling tour reference does not touch the legal/financial snapshot. Allow an
  -- UPDATE whose ONLY change is tour_id going non-null -> null.
  if tg_op = 'UPDATE'
     and old.tour_id is not null and new.tour_id is null
     and new.id               is not distinct from old.id
     and new.invoice_id       is not distinct from old.invoice_id
     and new.description      is not distinct from old.description
     and new.quantity         is not distinct from old.quantity
     and new.unit_price_net   is not distinct from old.unit_price_net
     and new.vat_percentage   is not distinct from old.vat_percentage
     and new.line_total_net   is not distinct from old.line_total_net
     and new.line_total_vat   is not distinct from old.line_total_vat
     and new.line_total_gross is not distinct from old.line_total_gross
     and new.sort_order       is not distinct from old.sort_order
  then
    return new;
  end if;

  select status into v_status
  from public.invoices
  where id = coalesce(new.invoice_id, old.invoice_id);

  if v_status in ('finalized', 'storniert') then
    raise exception 'Cannot modify line items of a % invoice', v_status
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger trg_line_item_immutability
  before insert or update or delete on public.invoice_line_items
  for each row execute function public.enforce_line_item_immutability();

-- >>> 20260627000500_rpcs.sql >>>
-- ============================================================================
-- Atomic operations as SECURITY DEFINER RPCs.
-- See docs/supabase-saas-plan.md §4. These replace the JSON write-races in
-- electron/main.ts with single-transaction Postgres functions. SECURITY DEFINER
-- so they may flip a finalized invoice to 'storniert' past the immutability
-- trigger and read the locked settings row; tenancy is re-checked explicitly via
-- is_org_member().
--
-- Payload contract: callers send snake_case JSON whose keys match the table
-- columns (the SupabaseDataGateway maps camelCase domain -> snake_case). Extra
-- keys (e.g. line_items, vat_breakdown on the invoice object) are ignored by
-- jsonb_populate_record, so the gateway can pass the whole domain object.
-- ============================================================================

-- Serialize the invoice + its line items into the domain-ish shape callers expect.
create or replace function public.invoice_json(p_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(i) || jsonb_build_object(
    'line_items',
    coalesce(
      (select jsonb_agg(to_jsonb(li) order by li.sort_order)
       from public.invoice_line_items li
       where li.invoice_id = i.id),
      '[]'::jsonb
    )
  )
  from public.invoices i
  where i.id = p_id;
$$;

-- ── create_invoice ────────────────────────────────────────────────────────────
-- Insert a draft invoice + its line items in one transaction. Always a draft
-- with a null number (regular invoices only get numbered at finalize); use
-- create_credit_note for credit notes, which carry a derived number.
create or replace function public.create_invoice(p_invoice jsonb, p_line_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_row public.invoices;
begin
  if v_org is null then
    raise exception 'No organization for current user';
  end if;

  v_row := jsonb_populate_record(null::public.invoices, p_invoice);
  v_row.id              := gen_random_uuid()::text;
  v_row.organization_id := v_org;
  v_row.invoice_number  := null;       -- never numbered on create
  v_row.status          := 'draft';
  v_row.created_at      := now();
  v_row.updated_at      := now();

  insert into public.invoices values (v_row.*);

  insert into public.invoice_line_items (
    id, invoice_id, tour_id, description, quantity, unit_price_net,
    vat_percentage, line_total_net, line_total_vat, line_total_gross, sort_order
  )
  select coalesce(li.id, gen_random_uuid()::text), v_row.id, li.tour_id, li.description,
         li.quantity, li.unit_price_net, li.vat_percentage,
         li.line_total_net, li.line_total_vat, li.line_total_gross, li.sort_order
  from jsonb_populate_recordset(null::public.invoice_line_items, coalesce(p_line_items, '[]'::jsonb)) li;

  return public.invoice_json(v_row.id);
end;
$$;

-- ── update_invoice ────────────────────────────────────────────────────────────
-- Patch a draft's header and (optionally) replace its whole line-item set in ONE
-- transaction. Replaces the gateway's previous non-transactional
-- update + delete-all + re-insert, which could strand an invoice with no line
-- items if the re-insert failed. p_updates carries only the changed scalar
-- columns (merged onto the current row); p_line_items is null to leave items
-- untouched, or the full replacement set. The immutability trigger still rejects
-- edits to a finalized/storniert invoice, rolling back the whole call.
create or replace function public.update_invoice(p_id text, p_updates jsonb, p_line_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv   public.invoices;
  v_patch public.invoices;
begin
  select * into v_inv from public.invoices where id = p_id for update;
  if not found then
    return null;
  end if;
  if not public.is_org_member(v_inv.organization_id) then
    raise exception 'Not authorized';
  end if;

  -- Merge the provided keys onto the current row; absent keys keep their values.
  v_patch := jsonb_populate_record(v_inv, coalesce(p_updates, '{}'::jsonb));

  update public.invoices set
    invoice_number                 = v_patch.invoice_number,
    invoice_date                   = v_patch.invoice_date,
    salutation                     = v_patch.salutation,
    customer_name                  = v_patch.customer_name,
    customer_address               = v_patch.customer_address,
    customer_email                 = v_patch.customer_email,
    company_name                   = v_patch.company_name,
    company_address                = v_patch.company_address,
    company_city_country           = v_patch.company_city_country,
    company_tax_id                 = v_patch.company_tax_id,
    company_customer_name          = v_patch.company_customer_name,
    purchase_order_number          = v_patch.purchase_order_number,
    tour_date                      = v_patch.tour_date,
    meeting_point                  = v_patch.meeting_point,
    pax                            = v_patch.pax,
    guide                          = v_patch.guide,
    civitatis_id                   = v_patch.civitatis_id,
    payment_method                 = v_patch.payment_method,
    type                           = v_patch.type,
    credit_note_for_invoice_number = v_patch.credit_note_for_invoice_number,
    is_paid                        = v_patch.is_paid,
    language                       = v_patch.language,
    status                         = v_patch.status,
    total_net                      = v_patch.total_net,
    total_vat                      = v_patch.total_vat,
    total_gross                    = v_patch.total_gross
    -- organization_id / id / created_at are intentionally never reassigned;
    -- updated_at is stamped by the touch trigger.
  where id = p_id;

  -- Replace the whole line-item set only when provided (drafts only — the
  -- immutability trigger blocks this on finalized/storniert invoices).
  if p_line_items is not null then
    delete from public.invoice_line_items where invoice_id = p_id;
    insert into public.invoice_line_items (
      id, invoice_id, tour_id, description, quantity, unit_price_net,
      vat_percentage, line_total_net, line_total_vat, line_total_gross, sort_order
    )
    select coalesce(li.id, gen_random_uuid()::text), p_id, li.tour_id, li.description,
           li.quantity, li.unit_price_net, li.vat_percentage,
           li.line_total_net, li.line_total_vat, li.line_total_gross, li.sort_order
    from jsonb_populate_recordset(null::public.invoice_line_items, p_line_items) li;
  end if;

  return public.invoice_json(p_id);
end;
$$;

-- ── finalize_invoice ──────────────────────────────────────────────────────────
-- Mirrors electron/main.ts `invoice:finalize`:
--   • credit notes / already-numbered invoices just flip to 'finalized';
--   • a regular draft gets a number YYMMDD-HHmm-NNN built from the org's
--     year-aware counter, then the counter is bumped.
-- The invoice row is locked FOR UPDATE first (serializes double-finalize of the
-- same invoice), then the settings row FOR UPDATE (serializes counter handout
-- across the org) — consistent lock order: invoice, then settings.
-- Timezone is Europe/Vienna (Austrian business: VAT 10/13/20).
create or replace function public.finalize_invoice(p_invoice_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv      public.invoices;
  v_settings public.company_settings;
  v_now      timestamptz := now();
  v_local    timestamp;
  v_year     int;
  v_counter  int;
  v_number   text;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    return null;
  end if;
  if not public.is_org_member(v_inv.organization_id) then
    raise exception 'Not authorized';
  end if;

  -- Already finalized/storniert (re-entrant call): return current state.
  if v_inv.status <> 'draft' then
    return public.invoice_json(v_inv.id);
  end if;

  -- Credit notes already carry a derived number — just flip the status. Gate this on
  -- the credit-note TYPE, not merely "a number is present": a regular invoice must
  -- always draw its number from the org counter here, so a client-set invoice_number
  -- on a draft (a forge attempt) can never be honored — it's overwritten below.
  if v_inv.type = 'credit_note' then
    if v_inv.invoice_number is null then
      raise exception 'Credit note % has no number to finalize', v_inv.id;
    end if;
    update public.invoices set status = 'finalized', updated_at = v_now where id = v_inv.id;
    return public.invoice_json(v_inv.id);
  end if;

  -- Regular draft: allocate the next number under a row lock.
  select * into v_settings
  from public.company_settings
  where organization_id = v_inv.organization_id
  for update;
  if not found then
    -- No settings row (failed signup trigger / manual deletion): bail rather than
    -- silently restart the counter at 1 and hand out a duplicate number.
    raise exception 'No settings row for organization % — cannot allocate invoice number', v_inv.organization_id;
  end if;

  v_local := v_now at time zone 'Europe/Vienna';
  v_year  := extract(year from v_local)::int;

  if v_settings.invoice_counter_year is not null and v_settings.invoice_counter_year <> v_year then
    v_counter := 1;                                   -- year rollover resets the counter
  else
    v_counter := coalesce(v_settings.invoice_counter, 1);
  end if;

  v_number := to_char(v_local, 'YYMMDD') || '-' || to_char(v_local, 'HH24MI') || '-' || lpad(v_counter::text, 3, '0');

  update public.invoices
     set invoice_number = v_number, status = 'finalized', updated_at = v_now
   where id = v_inv.id;

  update public.company_settings
     set invoice_counter = v_counter + 1, invoice_counter_year = v_year, updated_at = v_now
   where organization_id = v_inv.organization_id;

  return public.invoice_json(v_inv.id);
end;
$$;

-- ── create_credit_note ────────────────────────────────────────────────────────
-- Mirrors electron/main.ts `invoice:createCreditNote`: insert the credit note
-- (a draft carrying the derived number) AND flip the original to 'storniert' in
-- one transaction. Guards that the original's number matches the payload's
-- credit_note_for_invoice_number, exactly like main.ts.
create or replace function public.create_credit_note(p_original_id text, p_invoice jsonb, p_line_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := public.current_org_id();
  v_orig public.invoices;
  v_row  public.invoices;
begin
  if v_org is null then
    raise exception 'No organization for current user';
  end if;

  select * into v_orig from public.invoices where id = p_original_id for update;
  if not found then
    raise exception 'Original invoice % not found', p_original_id;
  end if;
  if not public.is_org_member(v_orig.organization_id) then
    raise exception 'Not authorized';
  end if;

  if coalesce(v_orig.invoice_number, '') is distinct from coalesce(p_invoice->>'credit_note_for_invoice_number', '') then
    raise exception 'creditNoteForInvoiceNumber mismatch: payload has "%" but original has "%"',
      p_invoice->>'credit_note_for_invoice_number', v_orig.invoice_number;
  end if;

  v_row := jsonb_populate_record(null::public.invoices, p_invoice);
  v_row.id              := gen_random_uuid()::text;
  v_row.organization_id := v_org;
  v_row.type            := 'credit_note';  -- never trust the payload's classification
  v_row.status          := 'draft';        -- always born a draft so line items are
                                           -- accepted and it must go through finalize_invoice
  v_row.created_at      := now();
  v_row.updated_at      := now();

  insert into public.invoices values (v_row.*);

  insert into public.invoice_line_items (
    id, invoice_id, tour_id, description, quantity, unit_price_net,
    vat_percentage, line_total_net, line_total_vat, line_total_gross, sort_order
  )
  select coalesce(li.id, gen_random_uuid()::text), v_row.id, li.tour_id, li.description,
         li.quantity, li.unit_price_net, li.vat_percentage,
         li.line_total_net, li.line_total_vat, li.line_total_gross, li.sort_order
  from jsonb_populate_recordset(null::public.invoice_line_items, coalesce(p_line_items, '[]'::jsonb)) li;

  -- Flip the original to storniert (allowed transition per the immutability trigger).
  update public.invoices set status = 'storniert', updated_at = now() where id = v_orig.id;

  return public.invoice_json(v_row.id);
end;
$$;

grant execute on function public.invoice_json(text)                          to authenticated;
grant execute on function public.create_invoice(jsonb, jsonb)                to authenticated;
grant execute on function public.update_invoice(text, jsonb, jsonb)          to authenticated;
grant execute on function public.finalize_invoice(text)                      to authenticated;
grant execute on function public.create_credit_note(text, jsonb, jsonb)      to authenticated;

-- >>> 20260627000600_import.sql >>>
-- ============================================================================
-- One-time local-JSON -> cloud import (docs/supabase-saas-plan.md §6).
-- Single transaction: settings + tours + invoices + line items for the caller's
-- org. Refuses to run if the org already holds tours/invoices (idempotency).
--
-- Unlike create_invoice, this PRESERVES existing ids, invoice_number, status and
-- timestamps — these are already-numbered legal records being migrated, not new
-- drafts. To get line items past the immutability trigger, each invoice is
-- inserted as 'draft', its line items added, then its real status restored
-- (draft -> finalized/storniert is an allowed transition).
--
-- Caveat: created_at and (for drafts) updated_at are preserved on INSERT. Because
-- the updated_at touch trigger (migration 700) fires on the status-restore UPDATE,
-- non-draft invoices end up with updated_at = import time; created_at and
-- invoice_date (the legal issue date) are still preserved.
-- ============================================================================
create or replace function public.import_org_data(p_settings jsonb, p_tours jsonb, p_invoices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid := public.current_org_id();
  v_s        public.company_settings;
  v_tour     public.tours;
  v_inv_json jsonb;
  v_inv      public.invoices;
  v_status   text;
  v_tours    int := 0;
  v_invoices int := 0;
begin
  if v_org is null then
    raise exception 'No organization for current user';
  end if;

  -- Idempotency / safety: never import on top of existing data.
  if exists (select 1 from public.tours where organization_id = v_org)
     or exists (select 1 from public.invoices where organization_id = v_org) then
    raise exception 'Org already has data — import aborted';
  end if;

  -- ── Settings: overwrite the empty row created at signup (keep defaults for any
  --    missing keys via coalesce so NOT NULL columns stay valid).
  if p_settings is not null and jsonb_typeof(p_settings) = 'object' then
    v_s := jsonb_populate_record(null::public.company_settings, p_settings);
    update public.company_settings cs set
      language               = coalesce(v_s.language, cs.language),
      invoice_counter        = coalesce(v_s.invoice_counter, cs.invoice_counter),
      invoice_counter_year   = coalesce(v_s.invoice_counter_year, cs.invoice_counter_year),
      company_name           = coalesce(v_s.company_name, cs.company_name),
      company_address        = coalesce(v_s.company_address, cs.company_address),
      city_country           = coalesce(v_s.city_country, cs.city_country),
      vat_number             = coalesce(v_s.vat_number, cs.vat_number),
      logo_path              = coalesce(v_s.logo_path, cs.logo_path),
      default_vat_percentage = coalesce(v_s.default_vat_percentage, cs.default_vat_percentage),
      bank_name              = coalesce(v_s.bank_name, cs.bank_name),
      account_holder         = coalesce(v_s.account_holder, cs.account_holder),
      iban                   = coalesce(v_s.iban, cs.iban),
      bic                    = coalesce(v_s.bic, cs.bic),
      legal_form             = coalesce(v_s.legal_form, cs.legal_form),
      headquarters           = coalesce(v_s.headquarters, cs.headquarters),
      court_registry         = coalesce(v_s.court_registry, cs.court_registry),
      registration_number    = coalesce(v_s.registration_number, cs.registration_number),
      brand_color            = coalesce(v_s.brand_color, cs.brand_color),
      invoice_footer_text    = coalesce(v_s.invoice_footer_text, cs.invoice_footer_text),
      email_subject_de       = coalesce(v_s.email_subject_de, cs.email_subject_de),
      email_subject_en       = coalesce(v_s.email_subject_en, cs.email_subject_en),
      email_body_de          = coalesce(v_s.email_body_de, cs.email_body_de),
      email_body_en          = coalesce(v_s.email_body_en, cs.email_body_en),
      updated_at             = now()
    where cs.organization_id = v_org;
  end if;

  -- ── Tours (preserve ids — line items reference tour_id).
  for v_tour in
    select (jsonb_populate_record(null::public.tours, t)).*
    from jsonb_array_elements(coalesce(p_tours, '[]'::jsonb)) as t
  loop
    v_tour.organization_id := v_org;
    if v_tour.id is null then v_tour.id := gen_random_uuid()::text; end if;
    if v_tour.created_at is null then v_tour.created_at := now(); end if;
    if v_tour.updated_at is null then v_tour.updated_at := now(); end if;
    insert into public.tours values (v_tour.*);
    v_tours := v_tours + 1;
  end loop;

  -- ── Invoices + line items.
  for v_inv_json in select * from jsonb_array_elements(coalesce(p_invoices, '[]'::jsonb))
  loop
    v_inv := jsonb_populate_record(null::public.invoices, v_inv_json);
    v_status := coalesce(v_inv.status, 'draft');
    v_inv.organization_id := v_org;
    if v_inv.id is null then v_inv.id := gen_random_uuid()::text; end if;
    if v_inv.created_at is null then v_inv.created_at := now(); end if;
    if v_inv.updated_at is null then v_inv.updated_at := now(); end if;
    v_inv.status := 'draft';                       -- insert as draft so line items are accepted
    insert into public.invoices values (v_inv.*);

    insert into public.invoice_line_items (
      id, invoice_id, tour_id, description, quantity, unit_price_net,
      vat_percentage, line_total_net, line_total_vat, line_total_gross, sort_order
    )
    select coalesce(li.id, gen_random_uuid()::text),
           v_inv.id,
           -- null out any dangling tour reference (deleted tour) to satisfy the FK
           (select t.id from public.tours t where t.id = li.tour_id and t.organization_id = v_org),
           li.description, li.quantity, li.unit_price_net, li.vat_percentage,
           li.line_total_net, li.line_total_vat, li.line_total_gross, li.sort_order
    from jsonb_populate_recordset(null::public.invoice_line_items, coalesce(v_inv_json->'line_items', '[]'::jsonb)) li;

    if v_status <> 'draft' then
      update public.invoices set status = v_status where id = v_inv.id;
    end if;
    v_invoices := v_invoices + 1;
  end loop;

  return jsonb_build_object('tours', v_tours, 'invoices', v_invoices);
end;
$$;

grant execute on function public.import_org_data(jsonb, jsonb, jsonb) to authenticated;

-- >>> 20260627000700_timestamps.sql >>>
-- ============================================================================
-- Server-authoritative updated_at.
--
-- Direct table updates from the client (SupabaseDataGateway.tour/invoice/settings
-- .update) previously stamped updated_at from the *browser* clock, while the
-- RPCs used the server's now() — two sources, and a skewed client clock could
-- write a wrong/older timestamp. These BEFORE UPDATE triggers make the database
-- the single source of truth, so the gateway no longer sends updated_at at all.
--
-- Trigger names sort AFTER the immutability trigger ('trg_invoice_immutability'
-- < 'trg_invoices_touch'), so immutability validates first; updated_at is not a
-- locked column, so the order is immaterial either way.
--
-- INSERT is deliberately not covered: the one-time importer (import_org_data)
-- preserves original created_at/updated_at on INSERT. Its post-insert status
-- restore on non-draft invoices is an UPDATE, so those imported rows get
-- updated_at = import time — acceptable, as created_at (and invoice_date) carry
-- the legal issue date.
-- ============================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_tours_touch
  before update on public.tours
  for each row execute function public.touch_updated_at();

create trigger trg_invoices_touch
  before update on public.invoices
  for each row execute function public.touch_updated_at();

create trigger trg_company_settings_touch
  before update on public.company_settings
  for each row execute function public.touch_updated_at();

