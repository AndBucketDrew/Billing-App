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
