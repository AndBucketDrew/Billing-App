-- ============================================================================
-- Idempotent delta — applies ONLY the code-review fixes on top of a project that
-- already has the Phase 1 schema (tables/RLS/policies). Safe to run more than
-- once: every function is `create or replace`, every trigger is dropped-if-exists
-- then recreated. No tables, columns, policies, or grants on existing objects
-- are touched. Paste into the Supabase SQL Editor and Run.
--
-- Covers: immutability tour-FK exemption (#1), atomic update_invoice (#2),
-- credit-note status/type hardening (#3), finalize settings-row guard (#4),
-- server-authoritative updated_at triggers (#10), and the invoice-forgery
-- hardening (#11): finalize never honors a client-set number on a regular
-- invoice, and direct 'authenticated' writes cannot mint a numbered/finalized
-- invoice or escalate a draft's status out of band.
-- ============================================================================

-- ── #11: invoice immutability — block out-of-band numbering / finalization ─────
-- The trigger now also fires on INSERT and refuses, for the 'authenticated' role,
-- any direct creation of a numbered/finalized invoice or any direct draft status
-- change. The SECURITY DEFINER RPCs run as the function owner and are unaffected.
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

-- Recreate the trigger so it also fires on INSERT (was update-or-delete only).
drop trigger if exists trg_invoice_immutability on public.invoices;
create trigger trg_invoice_immutability
  before insert or update or delete on public.invoices
  for each row execute function public.enforce_invoice_immutability();

-- ── #1: line-item immutability + tours FK on-delete-set-null exemption ─────────
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

-- ── #2: atomic update_invoice (header patch + optional line-item replace) ───────
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

grant execute on function public.update_invoice(text, jsonb, jsonb) to authenticated;

-- ── #4: finalize_invoice — guard against a missing settings row ────────────────
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

-- ── #3: create_credit_note — force draft status + credit_note type ─────────────
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

-- ── #10: server-authoritative updated_at triggers ──────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tours_touch            on public.tours;
drop trigger if exists trg_invoices_touch         on public.invoices;
drop trigger if exists trg_company_settings_touch on public.company_settings;

create trigger trg_tours_touch
  before update on public.tours
  for each row execute function public.touch_updated_at();

create trigger trg_invoices_touch
  before update on public.invoices
  for each row execute function public.touch_updated_at();

create trigger trg_company_settings_touch
  before update on public.company_settings
  for each row execute function public.touch_updated_at();
