# Reference site: LGRBbohrungen (LGRB-BW borehole portal)

> ⚠ **Use this for layout and flow only.** Our app is built for **Herrenknecht** and must use Herrenknecht branding (green `#7DB713`, Univers, uppercase headings). See [herrenknecht-brand.md](herrenknecht-brand.md). **Don't copy** the Baden-Württemberg yellow/black, the BW lion logo, or the LGRB header and footer.

**URL:** https://bohrungen.lgrb-bw.de/#bohrpunktkarte
**Who runs it:** Landesamt für Geologie, Rohstoffe und Bergbau (LGRB), Regierungspräsidium Freiburg, Baden-Württemberg.
**Why it matters:** the team chose it as the UI reference for our app. The organizers also included two screenshots of it in the dataset (`Standards_Formats/lgrb-BW_*.jpg`).
**Screenshots:** captured live on 2026-10-16 with Playwright at a 1600×1000 viewport. They are in [reference-ui/lgrb/](reference-ui/lgrb/).
**Example borehole used:** TK25-Archivnr. `7513-1890`, "GWMS 2/98 Altablagerung Am Schlachthof Offenburg", 11 m deep, 7 layers. It's the same borehole as in the organizers' screenshot.

## App structure

The site is a single page with 4 tabs (`#startseite`, `#bohrpunktkarte`, `#schichtdaten`, `#merkliste`):

| Tab | Purpose | Screenshot |
|---|---|---|
| Startseite | Landing page with 3 cards: Erste Schritte (getting started), Hilfe (help), Anzeigeportal (registration portal) | [00-startseite.png](reference-ui/lgrb/00-startseite.png) |
| **Bohrpunktkarte** | Borehole map: find boreholes | [01](reference-ui/lgrb/01-bohrpunktkarte-overview.png) to [05](reference-ui/lgrb/05-bohrpunktkarte-point-popup-and-table.png) |
| **Schichtdaten** | Layer data: one borehole in detail | [06](reference-ui/lgrb/06-schichtdaten-borehole-view.png) to [09](reference-ui/lgrb/09-schichtdaten-originaldokumente-tab.png) |
| Merkliste | Watchlist / basket of saved boreholes, with a counter badge in the tab | — |

## View 1: Bohrpunktkarte (map)

Top to bottom:
1. **Ortssuche** (place search, collapsible): one field for "Straße, Hausnummer, PLZ, Ort" (street, house number, postcode, town) and a "Suchen" (search) button.
2. **Filter** (collapsible, [03](reference-ui/lgrb/03-bohrpunktkarte-filter-panel.png)) with these fields:
   - Endteufe von / bis [m]: final depth from / to
   - TK25: map sheet number
   - Archivnummer: archive number
   - Gemarkung: cadastral district
   - Bohrzweck: drilling purpose, a dropdown (values below)
   - Mehrere TK25-Archivnummern: several archive numbers, separated by `;`
   - Buttons: "Filtern" (yellow) and "Zurücksetzen" (reset, dark)
3. **Map** (Leaflet with a grey basemap):
   - Zoomed out, points are **clustered** into numbered bubbles, e.g. "25k", coloured by depth class ([01](reference-ui/lgrb/01-bohrpunktkarte-overview.png)).
   - Zoomed in, each borehole is a **coloured dot**.
   - **Legend "Endteufe [m]"** (final depth): yellow 0–10, red >10–20, pink >20–50, purple >50–100, orange >100. A ringed dot marks "in Merkliste".
   - Controls on the left: zoom +/−, home, download. On the right: draw polygon / rectangle, edit, delete (area selection).
4. **Clicking a dot** opens a popup ([05](reference-ui/lgrb/05-bohrpunktkarte-point-popup-and-table.png)):
   - TK25-Archivnr., Name, Endteufe (final depth), Bohrzweck (purpose), LGRB geprüft (checked by LGRB)
   - Buttons: **Schichtdaten** (layer data, green when available), **Dokumente** (documents), **Zur Merkliste** (add to watchlist)
5. **Results table** under the map, listing the selected boreholes:
   - Columns: TK25-Archivnummer, ADB-ID, Aufschlussname (borehole name), Endteufe [m], LGRB geprüft, Online Schichtdaten, Originaldokumente, Zur Merkliste. Each column has a filter funnel.
   - Footer: "Karte zentrieren" (centre map) toggle, "N Bohrungen in Karte ausgewählt" (N boreholes selected), pagination, "Alle zur Merkliste" (all to watchlist).

**Bohrzweck values** (useful as a "purpose" taxonomy): Geologische Untersuchung, Baugrunderkundung, Bodenkundliche Untersuchung, Kohlenwasserstoffbohrung, Rohstofferkundung, Hydrogeologische Untersuchung, Altlastenerkundung, Seismik-Schussbohrung, Erdwärmenutzung, Mineralwasserbohrung, Thermalwasserbohrung, Kohlensäurebohrung, Geothermische Untersuchung, Lysimeter, Solebohrung, Grundwassermessstelle, Ingenieurgeologische Untersuchung (allgemein).

## View 2: Schichtdaten (single borehole)

Screenshot: [07 full page](reference-ui/lgrb/07-schichtdaten-fullpage.png).

The page is a 2-column dashboard.

**Left: "Bohrprofil" panel (the DIN 4023 profile drawing)**
- Header: TK25-Archivnr.
- Y axis: elevation "[m ü. NN]" (metres above sea level), with depth labels at every layer boundary (0,1 / 0,4 / 2,7 …).
- **Two columns side by side:**
  - **Stratigraphie**: stratigraphic units as pastel blocks labelled with codes (`qhy`, `qORT`).
  - **Petrographie**: lithology with **DIN 4023 hatching** on colour fills (circles = gravel, dots = sand, …).
- Zoom +/− and home buttons. The selected layer is outlined in red in both columns and in the table.

**Right, top: three cards side by side**
- **Stammdaten** (master data, key-value table):
  - Aufschlussname (borehole name), Bohrzweck (purpose), Bohrart (boring type), Bohrdatum (date)
  - Koordinaten (coordinates), e.g. "32U O: 421467.9 | N: 5369448.861" (UTM)
  - Endteufe (final depth), Ansatzhöhe (collar elevation, m ü. NN), LGRB geprüft (checked by LGRB)
- **Kartenansicht** (map view): a mini-map with a red dot.
- **Downloads**: an "Exporttyp" dropdown, a "Herunterladen" (download) button, and a "Zur Merkliste" button. Export types ([08](reference-ui/lgrb/08-schichtdaten-export-dropdown.png)):
  - Alles (.zip): everything
  - Bohrprofil (.pdf): profile drawing
  - Schichtdaten (.xls): layer data
  - SEP3 (.txt): German borehole exchange format
  - Originaldokumente (.pdf): original documents
  - GeoPackage (.gpkg)

**Right, bottom: two tabs**
- **Schichtenverzeichnis** (layer table), one row per layer:
  - # / von [m] / bis [m] (from / to)
  - Stratigraphie, with a filter
  - Petrographie (lithology), with a filter. Example values: "Kies [gerundet] (stark sandig)", "Schluff (schwach sandig, schwach kiesig)"
  - Farbe (colour)
  - Bohrgut (cuttings consistency, e.g. weich = soft, steif = stiff)
  - Zusatzinfos (extra info, e.g. "leicht zu bohren, erdfeucht" = easy to drill, earth-moist; "wassergesättigt" = water-saturated)
- **Originaldokumente** ([09](reference-ui/lgrb/09-schichtdaten-originaldokumente-tab.png)): a list of Dateiname (file name) and Dokumenttyp (document type), e.g. `BO_7513_01890_SV_1` = Schichtenverzeichnis (layer log), `BO_7513_01890_BP+AP_1` = Bohrprofil + Ausbauplan (profile + well construction plan).

## Visual language (LGRB's, for reference only: NOT our brand)

These colours were sampled from the screenshots so we know what to **avoid copying**. For our colours, see [herrenknecht-brand.md](herrenknecht-brand.md).

| Role | Hex |
|---|---|
| Brand yellow: header, newsletter band, primary button "Filtern" | `#FFFC00` |
| Near-black: active tab pill, secondary buttons, footer | `#2A2623` |
| Panel header background | `#F4F3F1` |
| Table header / zebra row | `#E4E1DC` |
| Profile fill: anthropogenic / fill (qhy) | `#E6E6E6` |
| Profile fill: Ortenau-Formation (qORT) | `#C8EBEB` |
| Profile fill: Quaternary undivided | `#FFE691` |
| Petrography fill: gravel (Kies) | `#FFFACD` (with black circle hatching) |
| Petrography fill: coarse sand (Grobsand) | `#FFA500` (with dot hatching) |
| Petrography fill: silt (Schluff) | `#9ACD32` (with silt hatching) |

- Functional government-portal style: thin borders, dense tables, zebra rows.
- Tabs are text links; the active tab is a dark pill with white text.
- The selected layer has a **red outline** that stays in sync between the profile drawing and the table.
- The petrography fills are CSS named colours (lemonchiffon, orange, yellowgreen) with DIN 4023 hatching on top, not the strict DIN Annex A palette.

## What to borrow and what to improve for our app

**Borrow:**
- Map → popup → detail flow
- The 2-column detail page (profile drawing on the left, data on the right)
- Profile and table selection kept in sync
- Export dropdown
- Watchlist ("Merkliste")
- The "Originaldokumente" link back to the source

**Our app has to add what LGRB doesn't need:**
- **Extraction review:** the source PDF/scan side by side with the extracted fields, plus confidence and provenance (which page or box a value came from).
- **Multi-language and multi-unit input:** ft→m conversion, depth below ground vs elevation.
- **The full Herrenknecht target format:** RQD, TCR, SPT, lab tests. See [target-format.md](target-format.md).
- **Worldwide projects** instead of one German state, so a project → boreholes hierarchy.
