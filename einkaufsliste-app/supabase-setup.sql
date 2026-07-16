-- ============================================================
-- SUPABASE-SETUP für die Wochenplan/Einkaufslisten-App
-- Im Supabase-Dashboard: SQL Editor → dieses Skript einfügen
-- und einmal ausführen ("Run").
-- ============================================================

-- ---------- Tabellen ----------
create table if not exists shopping_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  text text not null,
  checked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists pantry_items (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  checked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists week_plan (
  day_index int primary key,
  day text not null,
  meal text not null default '',
  time text not null default '',
  tag text not null default '',
  recipe_id uuid
);

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  url text not null,
  platform text not null default 'sonstige',
  thumbnail text not null default '',
  ingredients jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ---------- Row Level Security ----------
-- Für eine private 2-Personen-App: der anon-Key darf alles.
-- Hinweis: Damit kann JEDER, der eure Seiten-URL kennt, die Liste
-- bearbeiten. Für euch zwei okay, solange ihr den Link privat haltet.
-- Später härtbar über Supabase Auth (z. B. Magic-Link-Login).
alter table shopping_items enable row level security;
alter table pantry_items  enable row level security;
alter table week_plan     enable row level security;
alter table recipes       enable row level security;

create policy "anon_all_shopping" on shopping_items for all to anon using (true) with check (true);
create policy "anon_all_pantry"   on pantry_items  for all to anon using (true) with check (true);
create policy "anon_all_week"     on week_plan     for all to anon using (true) with check (true);
create policy "anon_all_recipes"  on recipes       for all to anon using (true) with check (true);

-- ---------- Realtime aktivieren ----------
alter publication supabase_realtime add table shopping_items;
alter publication supabase_realtime add table pantry_items;
alter publication supabase_realtime add table week_plan;
alter publication supabase_realtime add table recipes;

-- ---------- Startdaten ----------
insert into week_plan (day_index, day, meal, time, tag) values
  (0, 'Montag',     'Gelbes Kokos-Curry mit Süßkartoffel',        '35 Min', 'vegetarisch'),
  (1, 'Dienstag',   'Tomaten-Pasta mit Mozzarella & Basilikum',   '20 Min', 'schnell'),
  (2, 'Mittwoch',   'Gebratener Reis mit Frühlingsgemüse',        '25 Min', 'vegetarisch'),
  (3, 'Donnerstag', 'Quinoa-Bowl mit Kichererbsen & Limette',     '20 Min', 'vegan'),
  (4, 'Freitag',    'Restekochen — was der Vorrat hergibt',       '—',      'frei'),
  (5, 'Samstag',    'Pizza-Abend, selbst belegt',                 '45 Min', 'zu zweit'),
  (6, 'Sonntag',    'Brunch: Eier, Parmesan, frisches Brot',      '30 Min', 'gemütlich')
on conflict (day_index) do nothing;

insert into shopping_items (category, text) values
  ('obst',     '1 Süßkartoffel'),
  ('obst',     '2 Brokkoli'),
  ('obst',     '500 g Kirschtomaten'),
  ('obst',     '1 Limette'),
  ('glas',     '800 ml Kokosmilch'),
  ('glas',     '250 g passierte Tomaten'),
  ('glas',     '130 g Kichererbsen'),
  ('kraeuter', '1/2 Bund Petersilie'),
  ('getreide', '500 g Nudeln'),
  ('getreide', '500 g Reis'),
  ('getreide', '100 g Quinoa'),
  ('milch',    '1 Parmesan'),
  ('milch',    '350 ml Sahne'),
  ('milch',    '125 g Mozzarella'),
  ('tk',       '250 g Gemüsemischung');

insert into pantry_items (text) values
  ('1 Zwiebel'), ('1 Knoblauchzehe'), ('2 Eier'), ('Basilikum, TK'),
  ('Olivenöl'), ('Kokosöl'), ('Sojasauce'), ('gelbe Currypaste'),
  ('Salz'), ('Pfeffer');
