# Wochenplan & Einkaufsliste — für zwei

Private Web-App für euch beide: Essensplan, automatisch strukturierte
Einkaufsliste, Rezept-Import von TikTok/Instagram/YouTube und ein
Vorrats-Übertrag beim Wochenabschluss. **Mit Supabase als Datenbank
läuft alles in Echtzeit synchron auf beiden Handys.**

## Struktur

```
index.html           Seitenaufbau (Hero, Wochenplan, Liste, Vorrat)
style.css            Design-System (Weiß/Greige/Gold/Silber-Palette)
script.js            Logik, Smooth-Scroll, Supabase-/Lokal-Datenschicht
config.js            ⬅ HIER Supabase-Zugangsdaten eintragen
supabase-setup.sql   Einmalig im Supabase SQL-Editor ausführen
assets/              Die Interior-Hintergrundbilder
```

## Supabase einrichten (≈ 10 Minuten, kostenloser Plan reicht)

1. Auf [supabase.com](https://supabase.com) registrieren und ein
   neues Projekt anlegen (Region z. B. `eu-central-1`, Frankfurt).
2. Links im Menü **SQL Editor** öffnen → kompletten Inhalt von
   `supabase-setup.sql` einfügen → **Run**. Das erstellt die vier
   Tabellen, aktiviert Echtzeit-Updates und lädt die Startdaten.
3. **Project Settings → API** öffnen und zwei Werte kopieren:
   - *Project URL* → in `config.js` bei `SUPABASE_URL` eintragen
   - *anon public* Key → bei `SUPABASE_ANON_KEY` eintragen
4. Seite neu laden. Oben rechts erscheint **„● Live-Sync aktiv"** —
   ab jetzt sehen beide Geräte jede Änderung sofort (Häkchen,
   neue Artikel, Rezepte, Wochenplan).

**Ohne Konfiguration** läuft die App automatisch im Lokal-Modus
(localStorage, nur ein Gerät) — praktisch zum Testen.

### Sicherheitshinweis, ehrlich gesagt

Das Setup nutzt eine offene RLS-Policy: Jeder, der eure Seiten-URL
kennt, könnte die Liste bearbeiten (der anon-Key ist im Quellcode
sichtbar — das ist bei Supabase so vorgesehen, der Schutz kommt
normalerweise aus den Policies). Für eine private 2-Personen-App mit
nicht geteiltem Link ist das ein bewusster, pragmatischer Kompromiss.
Wenn ihr es härten wollt: Supabase Auth (Magic-Link-Login) aktivieren
und die Policies auf `authenticated` umstellen.

## Kostenlos hosten (GitHub Pages)

1. GitHub-Repo erstellen, alle Dateien hochladen (inkl. `assets/`).
2. **Settings → Pages → Source: main branch, `/ (root)`**.
3. Live unter `https://<username>.github.io/<repo>/`.

Hinweis: GitHub Pages braucht ein öffentliches Repo (im Free-Plan).
Der Supabase-anon-Key darf öffentlich sein, aber wegen der offenen
Policy gilt: URL nicht herumzeigen, oder später Auth nachrüsten.

## Design

- **Palette** direkt aus euren Interior-Bildern: Weiß `#FFFFFF`,
  Ivory `#F8F5F0`, Greige `#ECE7DF`, Stein `#D9D2C6`, Taupe `#A79E90`,
  Gold `#C6A46A`/`#A0824B` (Pendelleuchten), Silber `#C9CCD0`
  (Armaturen), warmes Nachtschwarz `#1C1B19` für Text.
- **Regel:** Text liegt nie direkt auf einem Bild. Alle Inhalte sitzen
  in opaken weißen Widgets mit schwarzer Schrift und einer 2px-Goldkante
  (die „Messingkante" als Signatur). Die Bilder sind reine Hintergründe
  mit langsamer Parallax-Bewegung.
- **Schrift:** Marcellus (Display) + Jost (Fließtext), Google Fonts.
- **Scroll-Gefühl:** eigener Lenis-artiger Smooth-Scroll — nativer
  Scroll wird per Lerp (8 %/Frame) weich nachgezogen, Hintergründe
  laufen mit eigenem Parallax-Tempo. Auf Touch-Geräten und bei
  `prefers-reduced-motion` bleibt der native Scroll aktiv (dort fühlt
  sich nativ besser an und vermeidet Ruckler), Parallax läuft weiter.

## Funktionen

- **Einkaufsliste**: Kategorien wie auf eurem Zettel, Häkchen,
  freies Hinzufügen pro Kategorie.
- **Wochenplan**: 7 Tageskarten, horizontal scrollbar.
- **Rezept-Import**: Link von YouTube/TikTok → Titel + Vorschaubild
  laden automatisch (öffentliches oEmbed). Instagram blockt das seit
  2020 ohne eigenen Meta-API-Zugang → Titel manuell. Zutaten einmal
  abtippen (automatisches Auslesen aus dem Video ist bei allen drei
  Plattformen ohne bezahlten API-Zugang nicht möglich), Kategorie und
  Wochentag wählen — fertig verteilt.
- **Woche abschließen**: Für jeden abgehakten Artikel entscheidet ihr
  per Schalter „Rest übrig" → wandert in den Vorrat, sonst weg.
- **Vorrat**: eigener Bereich mit Hinzufügen-Feld.

## Bekannte Grenzen

- oEmbed-Vorschau funktioniert nicht, wenn die Seite per Doppelklick
  als `file://` geöffnet wird (Browser-CORS bei `Origin: null`).
  Über GitHub Pages oder `python3 -m http.server` läuft sie.
- Bei gleichzeitigem Bearbeiten desselben Artikels gewinnt die
  letzte Änderung (last-write-wins) — für zwei Personen unkritisch.
