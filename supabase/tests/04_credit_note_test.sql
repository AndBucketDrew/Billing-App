-- ============================================================================
-- #4 Credit note — create_credit_note inserts a credit note AND flips the
-- original to 'storniert' in one transaction; it forces type=credit_note +
-- status=draft regardless of the payload, guards the number match, and a draft
-- credit note's line items cascade-delete with it.
-- See docs/supabase-saas-plan.md §9 and migration 20260627000500_rpcs.sql.
-- ============================================================================
begin;

insert into auth.users (instance_id, id, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a@test.local');
select set_config('test.user_a', '11111111-1111-1111-1111-111111111111', true);

set local role authenticated;
select plan(6);

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);

-- A finalized regular invoice to be credited.
select set_config('test.orig', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'Cust', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 100, 'total_vat', 20, 'total_gross', 120),
  jsonb_build_array(jsonb_build_object(
    'description', 'Tour', 'quantity', 1, 'unit_price_net', 100, 'vat_percentage', 20,
    'line_total_net', 100, 'line_total_vat', 20, 'line_total_gross', 120, 'sort_order', 0))
) ->> 'id'), true);
select set_config('test.orig_num', (public.finalize_invoice(current_setting('test.orig')) ->> 'invoice_number'), true);

-- Credit note: payload deliberately lies (type=invoice, status=finalized) to
-- prove the RPC overrides both.
select set_config('test.cn', (public.create_credit_note(
  current_setting('test.orig'),
  jsonb_build_object(
    'invoice_date', '2026-06-30', 'customer_name', 'Cust', 'customer_address', '', 'type', 'invoice', 'status', 'finalized',
    'language', 'de', 'total_net', -100, 'total_vat', -20, 'total_gross', -120,
    'credit_note_for_invoice_number', current_setting('test.orig_num')),
  jsonb_build_array(jsonb_build_object(
    'description', 'Storno', 'quantity', -1, 'unit_price_net', 100, 'vat_percentage', 20,
    'line_total_net', -100, 'line_total_vat', -20, 'line_total_gross', -120, 'sort_order', 0))
) ->> 'id'), true);

select is((select type   from public.invoices where id = current_setting('test.cn')), 'credit_note', 'credit note type is forced to credit_note');
select is((select status from public.invoices where id = current_setting('test.cn')), 'draft',       'credit note is forced to draft');
select is((select status from public.invoices where id = current_setting('test.orig')), 'storniert',  'original invoice is flipped to storniert');

-- Number-match guard.
select throws_ok(
  format($$select public.create_credit_note(%L,
            jsonb_build_object('invoice_date','2026-06-30','customer_name','Cust','language','de',
                               'credit_note_for_invoice_number','WRONG-NUMBER'),
            '[]'::jsonb)$$, current_setting('test.orig')),
  'P0001', null, 'create_credit_note rejects a mismatched original number');

-- A draft credit note + its line items cascade-delete cleanly.
select lives_ok(
  format($$delete from public.invoices where id = %L$$, current_setting('test.cn')),
  'a draft credit note can be deleted');
select is(
  (select count(*)::int from public.invoice_line_items where invoice_id = current_setting('test.cn')),
  0, 'its line items cascade-deleted');

select * from finish();
rollback;
