# DIN 4023 patterns

Seamless SVG fill patterns for soil and rock layers according to **DIN 4023:2023** (colour + hatch symbol).
Everything is keyed by the **DIN code** (e.g. `T` = clay, `Kst` = limestone): the code gives you the colour **and** the shape.
Which data field picks which symbol, with an example per group: [DATA_MAPPING.md](DATA_MAPPING.md).

```
assets/din4023_patterns/
├── DATA_MAPPING.md  # which record field draws which symbol, one example per group
├── din_codes.json   # DIN code → colour, symbol colour, svg file, pattern id, tile size
├── patterns.svg     # all 49 patterns as <pattern> definitions (for SVG)
├── svg/<file>.svg   # one seamless tile per DIN code (for CSS / images)
├── properties.json  # Table 6: property symbols drawn right of the column
├── properties/<group>_<key>.svg  # vertical tiles (repeat in y)
├── left_symbols.json  # Table 5: samples, groundwater, joints drawn left of the column
└── left_symbols/<group>_<key>.svg
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

## Samples, groundwater, joints (Table 5, left of the column)
DIN 4023 §5.6: depth numbers and these symbols go **left** of the column, soil codes and Table 6 symbols right.
`left_symbols.json` is an array, one entry per symbol. Black vector symbols on transparent, same units as Table 6:
```json
{
  "group": "groundwater", "key": "struck",
  "name_de": "Grundwasseroberfläche (beim Aufschluss angetroffen)", "name_en": "groundwater struck",
  "svg": "left_symbols/groundwater_struck.svg",
  "width": 72, "height": 66,
  "anchor": [36, 66],     // this point of the SVG sits on the depth line (null: see the symbol below)
  "repeat_y": false
}
```
The symbols only: the horizontal depth line (stroke width 5 at scale 1), numbers, dates and hours are text you draw (§5.7, §5.8).

| group | key | how to draw (DIN 4023 §5.7 / §5.8) |
|---|---|---|
| sample | `sample` | filled box, **bottom edge at the sample's bottom depth**; line from there right to the column, on it the top and bottom depth of the sample; before the box the sampling category and sample number: `A2` = category A, sample 2 |
| sample | `water_sample` | open triangle, base on the sample depth line; before it `W` and the sample number: `W8` |
| sample | `cored` | double line left of the column over the cored depth range; `repeat_y` tile (fixed width, repeat in y, never stretch) |
| groundwater | `struck` | open triangle on its tip, tip on the line at the depth where water was struck; depth above the line, date `(YYYY-MM-DD)` below it in brackets |
| groundwater | `after_drilling` | half-filled triangle: level after drilling, or after the water level changed; date in brackets plus hours since drilling stopped / paused: `(2021-09-30) 3 h` |
| groundwater | `rest` | filled triangle: rest water level in an observation well; date **without** brackets |
| groundwater | `rise` | arrow up from the struck level to the risen level, stretchable in y (see below). `top` = arrowhead, its top edge on the risen level; `bottom` = foot, its bottom edge on the struck level. `svg` is a preview at the norm's length |
| groundwater | `fall` | arrow down: `top` = V, its top edge on the struck level; `bottom` = arrowhead at the end of the arrow |
| joints | `dip` | drawn for dip direction 0° (arrow up). Rotate clockwise by the dip direction around `anchor` (135 → arrow to SE); write `dip direction / dip` along the line, e.g. `135 / 25` |

**Stretchable arrows (`rise`, `fall`).** `parts` has three files, all 70 wide with the shaft at x = 35:
```
top     groundwater_<rise|fall>_top.svg      62 high, fixed
middle  groundwater_arrow_middle.svg         10 high, repeat in y for any length
bottom  groundwater_<rise|fall>_bottom.svg   62 high, fixed
```
Stack them: top at the upper level, bottom ending at the lower level, the middle tile repeated in the gap (gap = distance − 124 at scale 1; a partly cut last tile is fine, it is a straight line). Gap below 0: the levels are too close for an arrow, draw only the triangles. Browsers can show a hairline where two images meet: overlap the parts by 1 unit.

Scale like the rest: one uniform factor for the whole drawing, never stretch a symbol.

## Source
Symbols traced from the tables of DIN 4023:2023-02 (Tables 1–3), colours from its Annex A; Table 5 and Table 6 symbols redrawn as vectors from the norm's measurements. The norm itself is published and copyrighted by DIN Media.
