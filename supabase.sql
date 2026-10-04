-- Ejecutar entero en Supabase > SQL Editor > New query > Run

create table if not exists public.productos (
  id            text primary key,
  nombre        text not null,
  cat           text not null default 'Otros',
  estado        text not null default 'hay' check (estado in ('hay','poco','falta')),
  cambio        bigint,
  ultimo_precio numeric(10,2),
  updated_at    timestamptz not null default now()
);

create table if not exists public.compras (
  id         text primary key,
  ts         bigint not null,
  tienda     text not null default '',
  items      jsonb not null default '[]'::jsonb,
  total      numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists compras_ts_idx on public.compras (ts desc);

-- Solo usuarios con sesión (tú y tu esposa) leen y escriben. Los registros nuevos van desactivados en Auth.
alter table public.productos enable row level security;
alter table public.compras   enable row level security;

drop policy if exists "casa_productos" on public.productos;
create policy "casa_productos" on public.productos for all to authenticated using (true) with check (true);

drop policy if exists "casa_compras" on public.compras;
create policy "casa_compras" on public.compras for all to authenticated using (true) with check (true);

-- Sincronización en tiempo real entre los dos móviles
alter publication supabase_realtime add table public.productos;
alter publication supabase_realtime add table public.compras;
