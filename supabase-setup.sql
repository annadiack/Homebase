-- Diesen Code in Supabase unter "SQL Editor" einfügen und auf "Run" klicken.

create table dashboard (
  key text primary key,
  value jsonb not null,
  updated_at timestamp with time zone default now()
);

-- Erlaubt Lesen und Schreiben ohne Login (für ein privates Zwei-Personen-Dashboard ausreichend,
-- solange die URL und der anon key nicht veröffentlicht werden).
alter table dashboard enable row level security;

create policy "Allow all access"
on dashboard
for all
using (true)
with check (true);
