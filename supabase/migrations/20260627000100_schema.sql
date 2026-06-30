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
