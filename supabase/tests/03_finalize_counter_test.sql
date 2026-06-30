-- ============================================================================
-- #2 Finalize counter — sequential finalizes hand out distinct, increasing
-- numbers (NNN), the counter advances, re-finalize is idempotent, the year
-- rollover resets NNN to 001, and the partial unique index forbids a duplicate
-- number within an org.
-- See docs/supabase-saas-plan.md §9 and migration 20260627000500_rpcs.sql.
--
-- NOTE: true PARALLEL finalize (the FOR UPDATE race) needs two concurrent
-- sessions and can't be exercised in single-session pgTAP. This pins the
-- counter/uniqueness invariants that make a duplicate impossible even if the
-- lock were lost — the partial unique index is the ultimate backstop.
-- ============================================================================
begin;

insert into auth.users (instance_id, id, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a@test.local'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'b@test.local');
select set_config('test.user_a', '11111111-1111-1111-1111-111111111111', true);
select set_config('test.user_b', '22222222-2222-2222-2222-222222222222', true);

set local role authenticated;
select plan(9);

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);
select set_config('test.year', extract(year from (now() at time zone 'Europe/Vienna'))::int::text, true);

-- Two drafts, finalized in order.
select set_config('test.inv1', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'C1', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 0, 'total_vat', 0, 'total_gross', 0),
  '[]'::jsonb) ->> 'id'), true);
select set_config('test.inv2', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'C2', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 0, 'total_vat', 0, 'total_gross', 0),
  '[]'::jsonb) ->> 'id'), true);

select set_config('test.num1', (public.finalize_invoice(current_setting('test.inv1')) ->> 'invoice_number'), true);
select set_config('test.num2', (public.finalize_invoice(current_setting('test.inv2')) ->> 'invoice_number'), true);

select ok(current_setting('test.num1') like '%-001', 'first finalize gets counter 001');
select ok(current_setting('test.num2') like '%-002', 'second finalize gets counter 002');
select is(
  (select invoice_counter from public.company_settings where organization_id = public.current_org_id()),
  3, 'counter advanced to 3 after two finalizes');

-- Re-finalizing the same invoice is idempotent: same number, no counter bump.
select is(
  (public.finalize_invoice(current_setting('test.inv1')) ->> 'invoice_number'),
  current_setting('test.num1'), 're-finalize returns the same number');
select is(
  (select invoice_counter from public.company_settings where organization_id = public.current_org_id()),
  3, 're-finalize does not bump the counter');

-- ── Year rollover: a stale counter_year resets NNN to 001 ─────────────────────
-- Run in a FRESH org (B): faking a rollover keeps "now" in the same minute as A's
-- -001, so regenerating -001 in org A would collide on (org, number) — which is
-- the unique index working correctly. A separate org isolates the reset cleanly.
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_b'), 'role', 'authenticated')::text, true);

update public.company_settings
   set invoice_counter = 99, invoice_counter_year = current_setting('test.year')::int - 1
 where organization_id = public.current_org_id();

select set_config('test.inv3', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'C3', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 0, 'total_vat', 0, 'total_gross', 0),
  '[]'::jsonb) ->> 'id'), true);
select set_config('test.num3', (public.finalize_invoice(current_setting('test.inv3')) ->> 'invoice_number'), true);

select ok(current_setting('test.num3') like '%-001', 'year rollover resets the counter to 001');
select is(
  (select invoice_counter from public.company_settings where organization_id = public.current_org_id()),
  2, 'counter is 2 after the post-rollover finalize');
select is(
  (select invoice_counter_year from public.company_settings where organization_id = public.current_org_id()),
  current_setting('test.year')::int, 'counter_year is stamped to the current year');

-- ── Partial unique index forbids a duplicate number within the org ────────────
select set_config('test.d1', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'D1', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 0, 'total_vat', 0, 'total_gross', 0),
  '[]'::jsonb) ->> 'id'), true);
select set_config('test.d2', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'D2', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 0, 'total_vat', 0, 'total_gross', 0),
  '[]'::jsonb) ->> 'id'), true);

update public.invoices set invoice_number = 'DUP-TEST' where id = current_setting('test.d1');
select throws_ok(
  format($$update public.invoices set invoice_number = 'DUP-TEST' where id = %L$$, current_setting('test.d2')),
  '23505', null, 'two invoices in one org cannot share an invoice_number');

select * from finish();
rollback;
