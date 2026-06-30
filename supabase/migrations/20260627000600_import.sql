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
