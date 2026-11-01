# Roller Tank 🛵⛽

Web-App fürs iPhone, die Tankstand, Verbrauch und Restreichweite deines Rollers
(voreingestellt: **Honda Bali 50, Typ AF32, 7 L Tank**) berechnet – und mit jeder
Tankung genauer wird.

**App öffnen:** https://m4tt3s-209.github.io/RollertankTracken/

## Auf dem iPhone installieren

1. Link oben in **Safari** öffnen.
2. Auf **Teilen** tippen (Quadrat mit Pfeil nach oben).
3. **„Zum Home-Bildschirm“** wählen.

Danach startet Roller Tank wie eine normale App im Vollbild und funktioniert auch offline.

## So benutzt du sie

| Wann | Was du einträgst |
|---|---|
| Beim Tanken | km-Stand + getankte Liter (Schalter „Vollgetankt“ an, wenn bis zum Rand) |
| Zwischendurch (optional) | aktueller km-Stand → Restreichweite und Tankinhalt werden aktualisiert |

Die erste Volltankung ist der Startpunkt. Ab der zweiten Volltankung kennt die App
deinen echten Verbrauch.

## Wie die Prognose lernt

- **Voll-zu-Voll-Messung:** Beim Volltanken entspricht die getankte Menge genau dem
  Verbrauch seit der letzten Volltankung. Teilbetankungen werden mitgezählt.
- **Gewichtung:** Längere Strecken zählen mehr (kleinerer Messfehler), neuere Tankungen
  zählen mehr (Wetter, Jahreszeit, Fahrweise) – Halbwertszeit 8 Tankungen.
- **Ausreißer** (z. B. nicht ganz voll getankt) werden per Median/MAD erkannt und abgewertet.
- **Startwert** (3,0 L/100 km) als Vorwissen, das mit jeder Messung an Einfluss verliert.
- **Unsicherheit:** Aus der Streuung ergibt sich ein 80-%-Bereich für die Reichweite,
  der mit mehr Daten schmaler wird.
- **Prognose-Check:** Vor jeder Tankung sagt die App voraus, wie viele Liter reinpassen,
  und vergleicht hinterher mit der echten Menge. Die Analyse zeigt, wie dieser Fehler
  über die Zeit kleiner wird.

## 2-Takt-Öl

Der Bali hat Getrenntschmierung: Eine Ölpumpe mischt das 2-Takt-Öl aus dem separaten
Öltank (ca. 1,2 L) automatisch bei, etwa im Verhältnis 1:40 bis 1:50.

- **Eintragen:** km-Stand + nachgefüllte Menge, Schalter „Bis zur Markierung“.
  Nur kontrolliert? `0` eintragen und den Schalter ausschalten.
- **Ölstand:** wird aus den gefahrenen km geschätzt, mit Warnung ab 0,3 L Rest.
- **Erinnerung:** alle 500 km „Öl kontrollieren“ (einstellbar).
- **Lernen:** Startwert = Benzinverbrauch ÷ 50. Ab dem zweiten Auffüllen bis zur Markierung
  lernt die App den echten Ölverbrauch (ml/100 km) und das tatsächliche Mischverhältnis.

## Daten

Alles bleibt lokal auf dem Gerät (`localStorage`). In den Einstellungen gibt es
Export/Import als JSON-Backup (z. B. in die Dateien-App / iCloud Drive).

## Entwicklung

```bash
npm test          # Tests der Analyse-Engine (Node ≥ 20)
npm start         # lokaler Server auf http://localhost:8080
```

Die Seite liegt in `site/` (reines HTML/CSS/JS, keine Abhängigkeiten).
Bei jedem Push baut `.github/workflows/pages.yml` die Seite und veröffentlicht sie auf
GitHub Pages.
