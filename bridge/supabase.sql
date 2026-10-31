-- FDE Council: shared, non-private records. Paste into Supabase → SQL Editor → Run.
-- Safe to run more than once.
-- Never store client memories here: only the client list and final plans.

create table if not exists public.clients (
  id     text primary key,          -- "client-1" .. "client-5"
  name   text not null,
  stack  text not null,
  status text not null default 'active'
);

create table if not exists public.plans (
  id         uuid primary key default gen_random_uuid(),
  seminar_id text not null,
  client_id  text not null references public.clients (id),
  request    text not null,
  plan       text not null,
  cites      text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists plans_created_at_idx on public.plans (created_at desc);

-- Lock the tables to the public (anon) key. The bridge uses the service key, which bypasses
-- RLS; the website reads through the bridge (GET /clients, GET /plans), not Supabase directly.
alter table public.clients enable row level security;
alter table public.plans enable row level security;
