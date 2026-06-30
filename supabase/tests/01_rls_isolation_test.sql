-- ============================================================================
-- #1 RLS tenancy isolation — two orgs cannot see or touch each other's rows.
-- See docs/supabase-saas-plan.md §9.
--
-- Harness: provision two tenants as the (superuser) test role so the signup
-- trigger fires, THEN `set role authenticated` once — RLS only applies to
-- non-owner/non-superuser roles, and pgTAP's temp bookkeeping ends up owned by
-- `authenticated` (created after the switch). Tenants A/B are impersonated by
-- swapping ONLY `request.jwt.claims.sub`, which is what auth.uid() reads.
-- ============================================================================
begin;

-- ── Provision two tenants (superuser; fires public.handle_new_user) ───────────
insert into auth.users (instance_id, id, email) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a@test.local'),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'b@test.local');

select set_config('test.user_a', '11111111-1111-1111-1111-111111111111', true);
select set_config('test.user_b', '22222222-2222-2222-2222-222222222222', true);
select set_config('test.org_a', (select org_id::text from public.organization_members where user_id = current_setting('test.user_a')::uuid), true);
select set_config('test.org_b', (select org_id::text from public.organization_members where user_id = current_setting('test.user_b')::uuid), true);

set local role authenticated;
select plan(8);

-- ── Tenant A creates a tour + an invoice ──────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);

with ins as (
  insert into public.tours (organization_id, name, description, meeting_point, base_price_net)
  values (public.current_org_id(), 'Tour A', '', '', 100)
  returning id
)
select set_config('test.tour_a', (select id from ins), true);

select set_config('test.inv_a', (public.create_invoice(
  jsonb_build_object('invoice_date', '2026-06-30', 'customer_name', 'Cust A', 'customer_address', '', 'type', 'invoice', 'language', 'de', 'total_net', 100, 'total_vat', 20, 'total_gross', 120),
  jsonb_build_array(jsonb_build_object(
    'description', 'x', 'quantity', 1, 'unit_price_net', 100, 'vat_percentage', 20,
    'line_total_net', 100, 'line_total_vat', 20, 'line_total_gross', 120, 'sort_order', 0))
) ->> 'id'), true);

select is((select count(*)::int from public.tours),    1, 'A sees its own tour');
select is((select count(*)::int from public.invoices), 1, 'A sees its own invoice');

-- ── Tenant B sees none of A's data and cannot write into A's org ──────────────
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_b'), 'role', 'authenticated')::text, true);

select is((select count(*)::int from public.tours),    0, 'B sees zero tours (isolation)');
select is((select count(*)::int from public.invoices), 0, 'B sees zero invoices (isolation)');
select is((select count(*)::int from public.tours where id = current_setting('test.tour_a')), 0,
          'B cannot select A''s tour by id');

-- B's UPDATE of A's tour is filtered to zero rows (silent no-op, not an error).
update public.tours set name = 'hijacked' where id = current_setting('test.tour_a');

-- B's INSERT into A's org is rejected by the WITH CHECK policy.
select throws_ok(
  format($$insert into public.tours (organization_id, name) values (%L, 'evil')$$, current_setting('test.org_a')),
  '42501', null, 'B cannot insert a tour into A''s org (RLS WITH CHECK)');

-- ── Back to A: the tour was untouched, and the two orgs are distinct ───────────
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text, true);

select is((select name from public.tours where id = current_setting('test.tour_a')), 'Tour A',
          'A''s tour survived B''s blocked update');
select ok(current_setting('test.org_a') <> current_setting('test.org_b'), 'each user got a distinct org');

select * from finish();
rollback;
