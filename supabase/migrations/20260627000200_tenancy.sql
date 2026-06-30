-- ============================================================================
-- Tenancy helpers + auto-provisioning on signup.
-- See docs/supabase-saas-plan.md §4 (Tenancy). 1 user = 1 org to start; the
-- membership table already supports multiple members per org later.
-- ============================================================================

-- Is the current user a member of the given org?  SECURITY DEFINER so it reads
-- organization_members WITHOUT triggering that table's own RLS (avoids the
-- classic policy-recursion problem). Used by every RLS policy and RPC below.
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
  );
$$;

-- The current user's org. Single-membership assumption for Phase 1; when
-- multi-org lands, RPCs take an explicit org_id instead of calling this.
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.org_id
  from public.organization_members m
  where m.user_id = auth.uid()
  order by m.created_at
  limit 1;
$$;

-- On signup: create the org, the owner membership, and an empty settings row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  insert into public.organizations (name) values ('') returning id into v_org_id;
  insert into public.organization_members (org_id, user_id, role) values (v_org_id, new.id, 'owner');
  insert into public.company_settings (organization_id) values (v_org_id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

grant execute on function public.is_org_member(uuid)  to authenticated;
grant execute on function public.current_org_id()      to authenticated;
