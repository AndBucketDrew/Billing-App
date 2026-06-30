-- ============================================================================
-- #5 Invoice-number forgery prevention — a direct 'authenticated' client cannot
-- mint a finalized/numbered invoice out of band, and finalize_invoice never
-- honors a client-set number on a regular invoice (it always draws from the org
-- counter). The legitimate path stays the SECURITY DEFINER RPCs.
-- See migration 20260627000400_immutability.sql + 20260627000500_rpcs.sql.
-- (check_violation == SQLSTATE 23514.)
-- ============================================================================
begin;

insert into auth.users (instance_id, id, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a@test.local');
select set_config('test.user_a', '11111111-1111-1111-1111-111111111111', true);

set local role authenticated;
select plan(5);

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);

-- A regular draft created the proper way.
select set_config('test.draft', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'C', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 0, 'total_vat', 0, 'total_gross', 0),
  '[]'::jsonb) ->> 'id'), true);

-- ── Direct out-of-band finalization is blocked ────────────────────────────────
select throws_ok(
  format($$update public.invoices set status = 'finalized' where id = %L$$, current_setting('test.draft')),
  '23514', null, 'a direct client cannot flip a draft to finalized (must use finalize_invoice)');

select throws_ok(
  format($$insert into public.invoices
             (organization_id, invoice_date, customer_name, customer_address,
              status, invoice_number, language, total_net, total_vat, total_gross)
           values (%L, '2026-06-30', 'X', '', 'finalized', 'FORGED-001', 'de', 0, 0, 0)$$,
         public.current_org_id()),
  '23514', null, 'a direct client cannot INSERT an already-finalized/numbered invoice');

-- ── Control: inserting a plain draft directly is still allowed ────────────────
select lives_ok(
  format($$insert into public.invoices
             (organization_id, invoice_date, customer_name, customer_address, language)
           values (%L, '2026-06-30', 'Y', '', 'de')$$, public.current_org_id()),
  'a plain draft (no number, status draft) can still be inserted directly');

-- ── finalize_invoice overwrites a client-set number on a regular invoice ──────
-- Setting invoice_number on a draft directly is permitted (the partial unique
-- index is the dup guard), but it must NOT survive finalization.
update public.invoices set invoice_number = 'FORGED-999' where id = current_setting('test.draft');
select set_config('test.num', (public.finalize_invoice(current_setting('test.draft')) ->> 'invoice_number'), true);

select ok(current_setting('test.num') <> 'FORGED-999',
          'finalize discards the client-set number on a regular invoice');
select ok(current_setting('test.num') like '%-001',
          'finalize allocates the counter number (NNN) instead');

select * from finish();
rollback;
