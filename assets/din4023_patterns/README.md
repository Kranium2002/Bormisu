# DIN 4023 patterns

Seamless SVG fill patterns for soil and rock layers according to **DIN 4023:2023** (colour + hatch symbol).
Everything is keyed by the **DIN code** (e.g. `T` = clay, `Kst` = limestone): the code gives you the colour **and** the shape.

```
assets/din4023_patterns/
├── din_codes.json   # DIN code → colour, symbol colour, svg file, pattern id, tile size
├── patterns.svg     # all 49 patterns as <pattern> definitions (for SVG)
├── svg/<file>.svg   # one seamless tile per DIN code (for CSS / images)
├── properties.json  # Table 6: property symbols drawn right of the column
└── properties/<group>_<key>.svg  # vertical tiles (repeat in y)
```

## Look up a DIN code
`din_codes.json` is an object keyed by DIN code (case-sensitive: `mG` = medium gravel, `Mg` = till marl):
```json
"Kst": {
  "kind": "rock",                 // soil | rock | geological
  "name_de": "Kalkstein",
  "name_en": "Limestone",
  "colour": "#2A4C67",            // DIN background colour (null only for "A" = fill)
  "symbol_colour": "#FFFFFF",     // symbol colour, already baked into the tile (white on dark colours)
  "svg": "svg/rock_Kst.svg",      // seamless tile: colour + symbol
  "pattern_id": "din-rock_Kst",   // id inside patterns.svg
  "tile_width": 50.395,           // size of ONE tile in user units (px)
  "tile_height": 11.265
}
```
Colour and symbol are already combined in every tile — never recolour or draw the symbol separately.

## How to fill an area (any size, any shape)
The tiles repeat **seamlessly** only if they are repeated at their **exact size and aspect ratio**. Rules:

1. **Repeat, never stretch.** Fill a shape by tiling, not by scaling one tile to the shape.
2. **Fixed tile size from `din_codes.json`** (`tile_width` × `tile_height`). To make patterns bigger or smaller, multiply **both** by the **same** factor.
3. **Same factor for the whole drawing.** All layers of a profile / map use one scale, so patterns look consistent.
4. **Do not rotate, skew or crop the tile.** The shape you fill may be anything (rectangle, polygon, circle); the pattern stays axis-aligned.
5. **Unknown or missing code:** fill plain `#E0E0E0`, no pattern. **`A` (fill / made ground)** has no colour: put a white background under it.

### SVG (recommended)
Copy the needed `<pattern>` from `patterns.svg` into the `<defs>` of your SVG (external `url(file.svg#id)` references do not work in browsers), then use it as `fill`:
```html
<svg width="200" height="300">
  <defs>
    <!-- copied from patterns.svg -->
    <pattern id="din-rock_Kst" patternUnits="userSpaceOnUse" width="50.395" height="11.265" viewBox="…">…</pattern>
  </defs>
  <!-- layer 2.0–5.5 m at 40 px per m, any shape works -->
  <rect x="0" y="80" width="80" height="140" fill="url(#din-rock_Kst)" stroke="#000"/>
</svg>
```
- Keep `patternUnits="userSpaceOnUse"` — **never** `objectBoundingBox` (that stretches the pattern to each shape → irregular).
- Bigger patterns: add `patternTransform="scale(2)"` to the `<pattern>` (uniform scale only).

### HTML / CSS
```html
<div style="background-image:url('assets/din4023_patterns/svg/rock_Kst.svg');
            background-repeat:repeat;
            background-size:50.395px 11.265px;   /* tile_width tile_height, both × the same factor */
            width:100%; height:240px"></div>
```
Never use `background-size: cover / contain / 100%` — that stretches the tile.

### Python (find what to draw)
```python
import json
codes = json.load(open("assets/din4023_patterns/din_codes.json", encoding="utf-8"))
c = codes.get(layer["din_code"])          # None -> plain #E0E0E0
svg_file, w, h = c["svg"], c["tile_width"], c["tile_height"]
```

## Codes (49)
| kind | DIN codes |
|---|---|
| soil | `gY` `Y` `X` `G` `gG` `mG` `fG` `S` `gS` `mS` `fS` `U` `gU` `T` `H` `V` `Bk` |
| rock | `Ko` `Br` `Sst` `Ust` `Tst` `Mst` `Kst` `Dst` `Ahst` `Gyst` `Sast` `Vst` `Stk` `Q` `Vu` `Pl` `Mem` `Meb` |
| geological | `Mu` `L` `Lx` `Lg` `Mg` `Lö` `Löl` `Kl` `Wk` `Bt` `F` `A` `Krst` `Ktst` |

File names are `<kind>_<code>` with `ö` → `oe` (e.g. `geological_Loe.svg`), because file systems may ignore case (`mG` vs `Mg`). Always go through `din_codes.json`, don't build file names yourself.

Sparse symbols are intended: `Mu` (topsoil), `A` (fill) and `Stk` (hard coal) show one symbol per tile, as in the norm.

## Property symbols (Table 6, right of the column)
Black vector symbols on transparent, drawn in a strip **next to** the layer, right of the column, over the layer's full height.
`properties.json` is an array, one entry per symbol:
```json
{
  "group": "density", "key": "dense",
  "name_de": "dicht", "name_en": "dense",
  "svg": "properties/density_dense.svg",
  "tile_width": 47, "tile_height": 47,   // size of ONE tile in user units
  "repeat_y": true,                      // repeat vertically to the layer height (false only for "wet")
  "frame": null                          // weathering only: thickness of the top / bottom edge to draw yourself
}
```
**Vertical scaling = repeat, never stretch.** Keep the width fixed and repeat the tile in y to any height (same rules as the fill patterns: one scale factor for both tile sides).
- CSS: `background:url(properties/density_dense.svg) repeat-y; background-size:<tile_width>px <tile_height>px`. `background-repeat: no-repeat round` instead fits a whole number of tiles (no cut-off dot at the bottom, tile height changes slightly).
- SVG: `<pattern patternUnits="userSpaceOnUse" width=tile_width height=tile_height>` with the tile inside, `fill="url(#…)"` on a rect as tall as the layer.
- **Weathering** (`frame` = 7): the tile has the side bars only; draw a top and bottom edge of that thickness at the layer boundaries (e.g. `border-top/bottom: 7px solid #000` at scale 1) to close the box.
- **`wet`** is a single mark, not a strip: draw it once at its size.

| group | key (DIN term) |
|---|---|
| moisture | `wet` (nass) |
| consistency | `liquid` (flüssig) · `very_soft` (breiig/sehr weich) · `soft` (weich) · `firm` (steif) · `stiff` (halbfest) · `hard` (fest) |
| density | `loose` (locker bis sehr locker) · `medium_dense` (mitteldicht) · `dense` (dicht) · `very_dense` (sehr dicht) |
| weathering | `w0` (frisch) · `w1` (schwach) · `w2_3` (mäßig bis stark) · `w4` (vollständig) · `w5` (zersetzt) |
| jointing | `jointed` (klüftig) · `highly_jointed` (stark klüftig) |

## Source
Symbols traced from the tables of DIN 4023:2023-02 (Tables 1–3), colours from its Annex A; Table 6 symbols redrawn as vectors from the norm's measurements. The norm itself is published and copyrighted by DIN Media.
