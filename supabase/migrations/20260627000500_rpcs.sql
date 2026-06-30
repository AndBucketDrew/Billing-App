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
