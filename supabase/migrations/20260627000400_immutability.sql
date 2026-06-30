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
