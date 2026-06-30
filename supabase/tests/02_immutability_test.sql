-- ============================================================================
-- #3 Legal immutability — finalized/storniert invoices and their line items are
-- frozen, EXCEPT: is_paid toggles, the finalized->storniert transition, and the
-- tour_id->null FK action when a referenced tour is deleted.
-- See docs/supabase-saas-plan.md §9 and migration 20260627000400_immutability.sql.
-- (check_violation == SQLSTATE 23514.)
-- ============================================================================
begin;

insert into auth.users (instance_id, id, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a@test.local');
select set_config('test.user_a', '11111111-1111-1111-1111-111111111111', true);

set local role authenticated;
select plan(9);

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);

-- A tour referenced by the invoice (used for the FK-exemption test).
with ins as (
  insert into public.tours (organization_id, name, base_price_net)
  values (public.current_org_id(), 'Tour T', 100) returning id
)
select set_config('test.tour', (select id from ins), true);

-- INV: a finalized invoice with one line item that references the tour.
select set_config('test.inv', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'Cust', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 100, 'total_vat', 20, 'total_gross', 120),
  jsonb_build_array(jsonb_build_object(
    'tour_id', current_setting('test.tour'), 'description', 'Tour T', 'quantity', 1,
    'unit_price_net', 100, 'vat_percentage', 20, 'line_total_net', 100,
    'line_total_vat', 20, 'line_total_gross', 120, 'sort_order', 0))
) ->> 'id'), true);
select public.finalize_invoice(current_setting('test.inv'));
select set_config('test.li', (select id from public.invoice_line_items where invoice_id = current_setting('test.inv') limit 1), true);

-- INV2: a second finalized invoice, for the storniert-transition test.
select set_config('test.inv2', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'Cust2', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 50, 'total_vat', 10, 'total_gross', 60),
  jsonb_build_array(jsonb_build_object(
    'description', 'y', 'quantity', 1, 'unit_price_net', 50, 'vat_percentage', 20,
    'line_total_net', 50, 'line_total_vat', 10, 'line_total_gross', 60, 'sort_order', 0))
) ->> 'id'), true);
select public.finalize_invoice(current_setting('test.inv2'));

-- ── Header immutability ───────────────────────────────────────────────────────
select throws_ok(
  format($$update public.invoices set customer_name = 'hacked' where id = %L$$, current_setting('test.inv')),
  '23514', null, 'financial field cannot change on a finalized invoice');

select lives_ok(
  format($$update public.invoices set is_paid = true where id = %L$$, current_setting('test.inv')),
  'is_paid still toggles on a finalized invoice');

select throws_ok(
  format($$delete from public.invoices where id = %L$$, current_setting('test.inv')),
  '23514', null, 'a finalized invoice cannot be deleted');

-- ── Line-item immutability ────────────────────────────────────────────────────
select throws_ok(
  format($$update public.invoice_line_items set line_total_gross = 999 where id = %L$$, current_setting('test.li')),
  '23514', null, 'line item of a finalized invoice cannot be edited');

select throws_ok(
  format($$delete from public.invoice_line_items where id = %L$$, current_setting('test.li')),
  '23514', null, 'line item of a finalized invoice cannot be deleted');

select throws_ok(
  format($$insert into public.invoice_line_items
             (invoice_id, description, quantity, unit_price_net, vat_percentage,
              line_total_net, line_total_vat, line_total_gross, sort_order)
           values (%L, 'sneak', 1, 1, 20, 1, 0.2, 1.2, 1)$$, current_setting('test.inv')),
  '23514', null, 'cannot add a line item to a finalized invoice');

-- ── Allowed exceptions ────────────────────────────────────────────────────────
select lives_ok(
  format($$update public.invoices set status = 'storniert' where id = %L$$, current_setting('test.inv2')),
  'finalized -> storniert transition is allowed');

-- Deleting the referenced tour fires tour_id -> null on a finalized line item;
-- the immutability trigger exempts that one FK-driven change.
select lives_ok(
  format($$delete from public.tours where id = %L$$, current_setting('test.tour')),
  'a tour used on a finalized invoice can still be deleted (FK set-null exemption)');

select is(
  (select tour_id from public.invoice_line_items where id = current_setting('test.li')),
  null, 'the finalized line item''s tour_id was nulled by the FK action');

select * from finish();
rollback;
