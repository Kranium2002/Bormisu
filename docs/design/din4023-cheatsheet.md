# DIN 4023 cheatsheet: how a borehole profile is drawn

Source: DIN 4023:2023-02 (licensed copy provided with the challenge data; the PDF and the hatching-pattern chart are **not** in this repo). This page is our own summary of the codes, colours and layout rules.

DIN 4023 is the German standard for the graphical representation of borehole logs: soil and rock types, their short codes, hatching symbols and colours, and layout rules. The LGRB portal's "Bohrprofil" column follows it.

## Layout rules for the profile column (section 5)

| Rule | What to draw |
|---|---|
| 5.1 Column | Each borehole is a vertical column: two vertical lines, horizontal lines at layer boundaries, longer lines at top and bottom. Different column widths can mark different boring types or core diameters. |
| 5.2 Scale | Vertical scale **1:100** where possible. |
| 5.3 Header | Above the column: borehole name and ground elevation at the collar (in the height system used). |
| 5.4 Depths | Depth numbers on the **left**, at each layer boundary (depth below collar, or elevation). Final depth written under the bottom line. |
| 5.6 Labels | **Right** of the column: soil/rock short codes or full names, plus optional geotechnical symbols, stratigraphy, colour, genesis. |
| 5.7 Samples | **Left** of the column: sample symbol, sample number, top/bottom depth. A continuous line on the left marks cored sections. |
| 5.8 Groundwater | **Left**: a horizontal line with an **empty downward triangle ▽** at the depth water was struck, plus depth and date (YYYY-MM-DD) in brackets. Half-filled triangle = level measured later (with hours elapsed). **Filled triangle ▼** = rest water level in a completed well. Arrows show water rising or falling after it was struck. |
| 5.10 Legend | Every profile needs a legend and the note "nach DIN 4023". |

## Soil types (Table 1, pure soils per DIN EN ISO 14688-1)

| Name (DE) | English | Main code | Secondary code | Colour |
|---|---|---|---|---|
| Großer Block / Block | Large boulder / boulder | gY / Y | gy / y | rot |
| Stein | Cobble | X | x | rot |
| Kies (Grob/Mittel/Fein) | Gravel (coarse/medium/fine) | G (gG/mG/fG) | g (gg/mg/fg) | gelb |
| Sand (Grob/Mittel/Fein) | Sand (coarse/medium/fine) | S (gS/mS/fS) | s (gs/ms/fs) | orange |
| Schluff | Silt | U | u | oliv |
| Grobschluff | Coarse silt | gU | gu | türkis |
| Ton | Clay | T | t | violett |
| Torf, Humus | Peat, humus | H | h | dunkelbraun |
| Vulkanische Aschen | Volcanic ash | V | — | grau |
| Braunkohle | Lignite | Bk | — | dunkelbraun |

**Mixed soils:** capital letter for the main component, lowercase for secondary ones. `u'` = weakly silty, `u̅` or `u*` = strongly silty. Example: `G, s, u'` = gravel, sandy, weakly silty. Third components are not drawn.

## Rock types (Table 2, per DIN EN ISO 14689)

| Name (DE) | English | Code | Colour |
|---|---|---|---|
| Konglomerat / Brekzie | Conglomerate / breccia | Ko / Br | gelb |
| Sandstein | Sandstone | Sst | orange |
| Schluffstein | Siltstone | Ust | oliv |
| Tonstein | Claystone | Tst | violett |
| Mergelstein | Marlstone | Mst | violettblau |
| Kalkstein / Dolomitstein | Limestone / dolostone | Kst / Dst | dunkelblau |
| Anhydrit / Gips / Salzgestein | Anhydrite / gypsum / rock salt | Ahst / Gyst / Sast | gelbgrün |
| Tuffstein | Tuff | Vst | grau |
| Steinkohle | Hard coal | Stk | schwarz |
| Quarzit | Quartzite | Q | rosa |
| Vulkanite / Plutonite | Volcanic / plutonic (basalt, granite) | Vu / Pl | rot |
| Massige Metamorphite | Massive metamorphic (gneiss) | Mem | rot |
| Blättrige Metamorphite | Foliated metamorphic (schist, phyllite) | Meb | violett |

Rock symbols are drawn in a **regular** grid; soil symbols are scattered irregularly.

## Common geological names (Table 3)

| Name (DE) | English | Code | Colour |
|---|---|---|---|
| Oberboden (Mutterboden) | Topsoil | Mu | gelblichbraun |
| Verwitterungslehm, Hanglehm | Weathered loam | L | grau |
| Hangschutt | Slope debris | Lx | grau |
| Geschiebelehm / -mergel | Glacial till / boulder marl | Lg / Mg | grau / violettblau |
| Löß / Lößlehm | Loess / loess loam | Lö / Löl | oliv |
| Klei, Schlick | Marine clay, silt mud | Kl | lila |
| Wiesenkalk, Seekreide | Lake marl | Wk | hellblau |
| Bänderton | Varved clay | Bt | violett |
| Mudde | Gyttja / sapropel | F | lila |
| Anthropogene Böden | Made ground / fill | A | — |
| Kreidestein / Kalktuff | Chalk / calcareous tufa | Krst / Ktst | hellblau |

## Official colour codes (Annex A, Table A.1)

This palette is ready to use for the profile column.

| Colour name | Hex | RGB | RAL |
|---|---|---|---|
| oliv | `#69633E` | 105, 99, 62 | 7008 |
| gelb | `#DBAB06` | 219, 171, 6 | 1032 |
| gelblichbraun | `#A5693A` | 165, 105, 58 | 8023 |
| rosa | `#C37280` | 195, 114, 128 | 3014 |
| orange | `#C6542F` | 198, 84, 47 | 2013 |
| dunkelbraun | `#5D4740` | 93, 71, 64 | 8015 |
| rot | `#BE4D58` | 190, 77, 88 | 3033 |
| lila | `#874680` | 135, 70, 128 | 4008 |
| violett | `#675181` | 103, 81, 129 | 4005 |
| violettblau | `#41496C` | 65, 73, 108 | 7015 |
| dunkelblau | `#2A4C67` | 42, 76, 103 | 5025 |
| hellblau | `#2F7DB7` | 47, 125, 183 | 5012 |
| gelbgrün | `#619A46` | 97, 154, 70 | 6017 |
| türkis | `#28A9B2` | 98, 213, 196 ⚠ | 6027 |
| grün | `#2D804A` | 45, 128, 74 | 6024 |
| grau | `#7F7F7F` | 127, 127, 127 | 7037 |
| schwarz | `#000000` | 0, 0, 0 | 9005 |

⚠ The standard itself is inconsistent for türkis: the RGB value (98, 213, 196) is not the hex value (#28A9B2). Pick one and stay consistent.

Note: the LGRB portal does **not** use these strict DIN colours. It uses lighter pastel fills (cream, light blue, orange, green) with the DIN hatching drawn on top. See [reference-ui/lgrb/07-schichtdaten-fullpage.png](reference-ui/lgrb/07-schichtdaten-fullpage.png).

## Other tables in the PDF (not transcribed)

- Table 4: examples of mixed-soil codes and symbols.
- Table 5: symbols for samples, groundwater and discontinuities (drawn left of the column).
- Table 6: symbols for geotechnical properties (drawn right of the column), e.g. consistency, density, jointing.
