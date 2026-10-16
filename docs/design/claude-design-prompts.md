# Claude Design: setup and prompts

How the UI prototype was made in [Claude Design](https://claude.ai/design), so anyone on the team can reproduce or extend it.

## Setup

1. Go to claude.ai/design → new project → template **UI mockups**. Use the default design system and Opus 5.5.
2. Upload these docs from this folder:
   - `challenge-brief.md`
   - `herrenknecht-brand.md`
   - `reference-site.md`
   - `target-format.md`
   - `din4023-cheatsheet.md`
3. Upload these images:
   - `reference-ui/lgrb/07-schichtdaten-fullpage.png`
   - `reference-ui/lgrb/01-bohrpunktkarte-overview.png`
   - A herrenknecht.com screenshot for the brand look
4. Paste **Prompt 1**. If the result looks like the Baden-Württemberg portal (yellow/black), paste **Prompt 2**.
5. Iterate one screen at a time with inline comments. When you're done, use **Export → Hand off to Claude Code**.

Don't upload anything from the confidential challenge dataset (reports, scans) to external tools.

## Prompt 1: the 4-screen prototype

```text
We're building "Bormisu" for the Herrenknecht hackathon challenge: "Automated extraction
and standardisation of drilling data for a global geodatabase". Read the attached docs first.

Users: geotechnical engineers at a tunnel-boring-machine maker. They receive borehole
reports (PDF scans, many languages) from projects worldwide and need clean, comparable data.

Design a clickable prototype with 4 screens:
1. World map: all boreholes worldwide, clustered, coloured by depth; search + filters
   (project, country, depth, has-rock-data); results table under the map. Structure like the
   LGRB "Bohrpunktkarte" screenshot, but global and modern.
2. Borehole detail: like the LGRB "Schichtdaten" screenshot. Left: DIN 4023 profile column
   (stratigraphy + lithology hatching, depth axis, groundwater ▽ marker). Right: metadata card,
   mini-map, layer table (from/to, lithology, SPT, RQD, TCR), export button (xlsx/csv/json).
   Selecting a layer highlights it in both the profile and the table.
3. Extraction review (our key differentiator): original scanned page on the left, extracted
   fields on the right with confidence badges. Click a field → highlight where it came from on
   the page. Show the original value next to the normalised one (e.g. "Cota 212,4" → 212.4 mASL;
   CRS guess with a warning). Approve / edit / flag buttons.
4. Upload & processing queue: drop reports, see per-document status (classifying pages →
   extracting → needs review → done), count of boreholes found.

Style: professional engineering tool, light theme, dense but calm, clear data tables.
Use the DIN 4023 colour palette from the cheatsheet for soil/rock types.
Use realistic but FICTIONAL sample data (no real project names).
```

## Prompt 2: rebrand to Herrenknecht

```text
Rebrand: this app is built FOR Herrenknecht AG (the tunnel-boring-machine maker who set
this challenge), not for Baden-Württemberg. LGRB was only a layout/flow reference.

- Remove all LGRB/BW branding: the yellow (#FFFC00), the yellow/black header and footer,
  the BW lion logo.
- Apply the Herrenknecht brand from herrenknecht-brand.md and the screenshots:
  primary green #7DB713, dark green #003E25 for the app bar/sidebar, text #181818 / #555555,
  borders #D6D6D6, page background #FCFCFC.
- Typography: Univers (fallback Inter/Helvetica). Headings heavy and ALL CAPS, nav bold uppercase.
- Header: "BORMISU · Borehole Intelligence for Herrenknecht", with a simple placeholder mark
  (green square with an "H").
- Selected/active states: green underline or outline instead of red.
- Map points: green = reviewed, grey = unreviewed, amber = needs attention.
- KEEP the DIN 4023 soil/rock colours in the profile column (engineering standard, not branding).
- KEEP all existing layouts, screens and flows; change only the visual identity.
```

## Design decisions so far

- **Look:** Herrenknecht brand (see [herrenknecht-brand.md](herrenknecht-brand.md)), not LGRB's.
- **Layout and flow:** LGRB's map → popup → borehole detail, with the profile drawing on the left and data on the right ([reference-site.md](reference-site.md)).
- **Differentiator:** the extraction review screen, with the source document next to the extracted fields plus confidence and provenance.
- **Profile column:** DIN 4023 hatching and colours ([din4023-cheatsheet.md](din4023-cheatsheet.md)).
- **Sample data in the prototype is fictional.**
