-- Supabase Dashboard > SQL Editor > New query에 전체 내용을 붙여넣고 Run.
-- recipe_id는 menu.json의 recipes[].id를 저장합니다.
-- 행 수준 보안: https://supabase.com/docs/guides/database/postgres/row-level-security
begin;

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id bigint not null check (recipe_id > 0),
  created_at timestamptz not null default now()
);

create unique index if not exists favorites_user_recipe_key
  on public.favorites (user_id, recipe_id);

alter table public.favorites enable row level security;

-- 로그인하지 않은 방문자는 접근할 수 없고, 수정(UPDATE)은 사용하지 않습니다.
revoke all on public.favorites from anon, authenticated;
grant select, insert, delete on public.favorites to authenticated;

drop policy if exists favorites_select_own on public.favorites;
create policy favorites_select_own on public.favorites
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists favorites_insert_own on public.favorites;
create policy favorites_insert_own on public.favorites
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists favorites_delete_own on public.favorites;
create policy favorites_delete_own on public.favorites
  for delete to authenticated
  using ((select auth.uid()) = user_id);

commit;
