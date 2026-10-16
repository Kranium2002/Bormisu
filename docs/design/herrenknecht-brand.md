# Herrenknecht brand: the look our app must have

**Our app is a tool for Herrenknecht AG**, the challenge sponsor and the world market leader in tunnel boring machines. It must look like a Herrenknecht product, **not** like the Baden-Württemberg LGRB portal. LGRB is only a reference for **layout and flow**. Don't copy its yellow/black state branding.

Source: https://www.herrenknecht.com/en/, captured 2026-10-16. Values were read from the site's CSS and sampled from screenshots.
Screenshots of herrenknecht.com are kept locally and not committed (their photos show identifiable people). To see the look, open the site.

## Identity

- **Name:** Herrenknecht AG, "Tunnelling Systems". Based in Schwanau, Germany.
- **Tagline:** *Pioneering Underground Together*
- **Logo:** a green square with a dark-green stylised **H**, "HERRENKNECHT" above it and "Tunnelling Systems" below. It sits top-right in their header. For our prototype a placeholder like "Bormisu · for Herrenknecht" is fine.

## Colours

| Role | Hex | Where they use it |
|---|---|---|
| **Herrenknecht green** (primary) | `#7DB713` | Section headings, tag labels ("BAUMA 2025"), primary buttons, active-tab underline, big feature panels |
| Logo dark green | `#003E25` | The "H" in the logo. Use it for dark accents, a sidebar or the header bar |
| Text, near-black | `#181818` | Body text, nav |
| Text, secondary | `#555555` | Secondary text, labels |
| Grey | `#868685` | Muted text, meta (dates, categories) |
| Divider / border | `#D6D6D6` | Lines, card borders |
| Light surface | `#EFEFEF` | Input backgrounds, subtle panels |
| Page background | `#FCFCFC` | Near-white page |
| White | `#FFFFFF` | Header, cards |

Green is the **only** strong accent. Everything else is neutral grey or near-black.

## Typography

- **Font:** **Univers** across the whole site. The fallback is a clean grotesque sans: Inter, Helvetica Neue or Arial.
- **Headlines:** heavy (Univers Black/Extra Bold), **ALL CAPS**, tight letter-spacing, often in green. Examples: "PIONEERING UNDERGROUND TOGETHER", "CURRENT NEWS".
- **Nav:** bold (600), all caps: PRODUCTS · APPLICATION · SERVICES · REFERENCES · CAREERS.
- **Body:** light weight (300), 16 px, generous line height.

## Components and feel

- Clean white header with a thin grey divider and the bold uppercase nav. The logo sits top-right.
- **Tag labels:** small green background, white uppercase text (e.g. "BAUMA 2025").
- **Buttons:** solid green with white text and about 4 px radius. Secondary buttons are outlined with a "›" chevron, e.g. "› READ MORE".
- **Cards:** white, square corners, soft shadow, bold title, light body, small grey meta row with icons.
- **Big green panels** for calls to action ("FOLLOW US ON").
- Industrial, engineered, confident. Big photography of machines and tunnels. Plenty of white space between sections, but data-dense where it matters.

## For our app (a data tool, not a marketing site)

- Header: our app name plus "for Herrenknecht", white, with green as the accent. A dark-green (`#003E25`) app bar or sidebar is also on-brand.
- Primary actions in green `#7DB713`; selected and active states use a green underline or outline, **not** LGRB's red outline and yellow.
- Section titles in heavy uppercase, like their headings, but smaller for an app.
- Map points: green for "verified / reviewed", grey for "unreviewed", amber for "needs attention". The depth-class colours from LGRB are optional.
- The soil/rock colours in the profile column still follow DIN 4023 (see [din4023-cheatsheet.md](din4023-cheatsheet.md)). That's an engineering standard, not branding, so it stays.
