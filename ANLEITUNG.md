# Unser Zuhause – Setup mit Supabase und GitHub Pages

## Teil 1: Datenbank in Supabase anlegen (~5 Min)

1. Geh auf https://supabase.com/dashboard und melde dich mit deinem Account an.
2. Klicke auf "New project". Gib einen Namen ein (z.B. "unser-zuhause"), leg ein Datenbank-Passwort fest (merken oder Passwortmanager, wird nachher nicht mehr gebraucht), wähl eine Region in eurer Nähe (z.B. Frankfurt/EU).
3. Warte, bis das Projekt fertig eingerichtet ist (etwa 1-2 Minuten).
4. Geh im Menü links auf das Symbol "SQL Editor".
5. Öffne die Datei `supabase-setup.sql` aus diesem Download, kopier den kompletten Inhalt, füg ihn im SQL Editor ein und klicke auf "Run". Das legt die Tabelle für die App an.
6. Geh im Menü links auf das Zahnrad-Symbol "Project Settings" → "API".
7. Dort findest du zwei Werte, die du brauchst:
   - "Project URL" (sieht aus wie `https://xxxxx.supabase.co`)
   - "anon public" key (ein langer Text unter "Project API keys")
8. Öffne die Datei `supabase-config.js` aus diesem Download und trag beide Werte anstelle der Platzhalter ein. Speichern.

## Teil 2: Auf GitHub Pages veröffentlichen (~5 Min)

1. Geh auf https://github.com und erstelle ein neues Repository (z.B. "unser-zuhause"). Kann privat oder öffentlich sein – der Code selbst ist unkritisch, nur die Supabase-Zugangsdaten sollten nicht allzu öffentlich rumliegen (siehe Hinweis unten).
2. Lad die drei Dateien aus diesem Download hoch: `index.html`, `supabase-config.js`, `supabase-setup.sql` (die SQL-Datei ist danach nicht mehr nötig, kann aber bleiben).
   - Einfachster Weg ohne Kommandozeile: Im Repository auf "Add file" → "Upload files" klicken, Dateien reinziehen, "Commit changes".
3. Geh im Repository auf "Settings" → "Pages" (im Menü links).
4. Unter "Build and deployment" → "Source" wähle "Deploy from a branch". Branch: "main", Ordner: "/ (root)". Speichern.
5. Nach ein bis zwei Minuten erscheint oben eine Web-Adresse wie `https://dein-username.github.io/unser-zuhause/`. Das ist eure App – den Link kannst du an deinen Partner schicken.

## Wichtiger Hinweis zur Sicherheit

Der "anon key" ist zum Verwenden im Browser gedacht und kein Geheimnis im klassischen Sinne, aber die aktuelle Datenbank-Regel (`supabase-setup.sql`) erlaubt jedem mit diesem Key vollen Lese- und Schreibzugriff auf die Tabelle. Für ein privates Zwei-Personen-Dashboard ist das in der Praxis unkritisch, solange ihr das Repository nicht aktiv bewerben. Falls du es sauberer absichern willst (z.B. mit Login für euch beide), sag mir Bescheid, dann bauen wir eine Supabase-Auth-Anmeldung ein.

## Ohne Supabase-Setup

Auch ohne Teil 1 funktioniert die Seite – die Daten werden dann nur lokal auf dem jeweiligen Gerät gespeichert (nicht geteilt). Oben in der App steht dann "nur dieses Gerät" statt "geteilt".
