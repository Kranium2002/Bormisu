# DIN 4023 symbols and the data that draws them

Which field of a borehole record (the API contract, `docs/design/api-contract.md`) decides which DIN 4023 symbol is drawn.
**One group = one variable**: every symbol in a group is picked by the value of the same field.
Each group has one worked example; the tables list every value. How to draw the files (tile size, anchors, never stretch) is in [README.md](README.md).

## Overview

| # | group | variable (record path) | DIN 4023 | where | example | in the data model |
|---|---|---|---|---|---|---|
| 1 | lithology fill | `stratigraphy[].din4023_code` | Tables 1–3 | in the column | <img src="svg/soil_G.svg" height="36"> `G` | ✅ |
| 2 | consistency / density | `stratigraphy[].consistency_density` | Table 6 | right of the column | <img src="properties/density_dense.svg" height="36"> `dense` | ✅ (free text) |
| 3 | groundwater level | `groundwater[].type` + `.depth_m` + `.date` | Table 5 | left of the column | <img src="left_symbols/groundwater_struck.svg" height="24"> `strike` | ✅ (contract), backend has only `water_table_m` |
| 4 | groundwater rise / fall | two readings of `groundwater[]` | Table 5 | left of the column | <img src="left_symbols/groundwater_rise.svg" height="48"> | derived |
| 5 | cored section | `stratigraphy[].core` | Table 5 | left of the column | <img src="left_symbols/sample_cored.svg" width="22" height="10"> `true` | ✅ (contract) |
| 6 | samples | `test_results[].sample_name` + `.sample_depth_m` | Table 5 | left of the column | <img src="left_symbols/sample_sample.svg" height="24"> `ES` | 🟡 no sampling category |
| 7 | weathering · jointing · moisture · water sample · joint dip | — | Tables 5, 6 | | | ❌ no field yet |

## 1. Lithology fill — `stratigraphy[].din4023_code`

**Example:** `"din4023_code": "G"` → Kies / Gravel, colour `#DBAB06`, file `svg/soil_G.svg`

<img src="svg/soil_G.svg" height="40">

Rules:

- The code is the DIN short form, case-sensitive (`mG` medium gravel ≠ `Mg` till marl). A composite code like `"G, s"` (gravel, sandy) is drawn with its **main component**, the first code: `G`. Secondary components are not drawn (DIN 4023 §4).
- The code alone decides colour **and** pattern; `kind` (soil · rock · geological) is just the table it comes from.
- `null` (no code in the source) → plain `#E0E0E0`, no pattern. A code that is not in this list → red with "no pattern assigned" (frontend), so missing patterns stand out.
- `A` (fill) has no DIN colour: white background under the pattern.


**Soils (Table 1)**

| `din4023_code` | Deutsch | English | colour | file |
|---|---|---|---|---|
| `gY` | Großer Block | Large boulders | `#BE4D58` | `svg/soil_gY.svg` |
| `Y` | Blöcke | Boulders | `#BE4D58` | `svg/soil_Y.svg` |
| `X` | Steine | Cobbles | `#BE4D58` | `svg/soil_X.svg` |
| `G` | Kies | Gravel | `#DBAB06` | `svg/soil_G.svg` |
| `gG` | Grobkies | Coarse gravel | `#DBAB06` | `svg/soil_gG.svg` |
| `mG` | Mittelkies | Medium gravel | `#DBAB06` | `svg/soil_mG.svg` |
| `fG` | Feinkies | Fine gravel | `#DBAB06` | `svg/soil_fG.svg` |
| `S` | Sand | Sand | `#C6542F` | `svg/soil_S.svg` |
| `gS` | Grobsand | Coarse sand | `#C6542F` | `svg/soil_gS.svg` |
| `mS` | Mittelsand | Medium sand | `#C6542F` | `svg/soil_mS.svg` |
| `fS` | Feinsand | Fine sand | `#C6542F` | `svg/soil_fS.svg` |
| `U` | Schluff | Silt | `#69633E` | `svg/soil_U.svg` |
| `gU` | Grobschluff | Coarse silt | `#28A9B2` | `svg/soil_gU.svg` |
| `T` | Ton | Clay | `#675181` | `svg/soil_T.svg` |
| `H` | Torf, Humus | Peat, humus | `#5D4740` | `svg/soil_H.svg` |
| `V` | Vulkanische Asche | Volcanic ash | `#7F7F7F` | `svg/soil_V.svg` |
| `Bk` | Braunkohle | Lignite | `#5D4740` | `svg/soil_Bk.svg` |

**Rocks (Table 2)**

| `din4023_code` | Deutsch | English | colour | file |
|---|---|---|---|---|
| `Ko` | Konglomerat | Conglomerate | `#DBAB06` | `svg/rock_Ko.svg` |
| `Br` | Brekzie | Breccia | `#DBAB06` | `svg/rock_Br.svg` |
| `Sst` | Sandstein | Sandstone | `#C6542F` | `svg/rock_Sst.svg` |
| `Ust` | Schluffstein | Siltstone | `#69633E` | `svg/rock_Ust.svg` |
| `Tst` | Tonstein | Claystone | `#675181` | `svg/rock_Tst.svg` |
| `Mst` | Mergelstein | Marlstone | `#41496C` | `svg/rock_Mst.svg` |
| `Kst` | Kalkstein | Limestone | `#2A4C67` | `svg/rock_Kst.svg` |
| `Dst` | Dolomitstein | Dolomite | `#2A4C67` | `svg/rock_Dst.svg` |
| `Ahst` | Anhydritstein | Anhydrite | `#619A46` | `svg/rock_Ahst.svg` |
| `Gyst` | Gipsstein | Gypsum | `#619A46` | `svg/rock_Gyst.svg` |
| `Sast` | Salzgestein | Rock salt | `#619A46` | `svg/rock_Sast.svg` |
| `Vst` | Tuffstein | Tuff | `#7F7F7F` | `svg/rock_Vst.svg` |
| `Stk` | Steinkohle | Hard coal | `#000000` | `svg/rock_Stk.svg` |
| `Q` | Quarzit | Quartzite | `#C37280` | `svg/rock_Q.svg` |
| `Vu` | Vulkanit | Volcanic rock (basalt) | `#BE4D58` | `svg/rock_Vu.svg` |
| `Pl` | Plutonit | Plutonic rock (granite) | `#BE4D58` | `svg/rock_Pl.svg` |
| `Mem` | Metamorphit, massig | Massive metamorphic (gneiss) | `#BE4D58` | `svg/rock_Mem.svg` |
| `Meb` | Metamorphit, geschiefert | Foliated metamorphic (schist) | `#675181` | `svg/rock_Meb.svg` |

**Geological names (Table 3)**

| `din4023_code` | Deutsch | English | colour | file |
|---|---|---|---|---|
| `Mu` | Mutterboden | Topsoil | `#A5693A` | `svg/geological_Mu.svg` |
| `L` | Verwitterungslehm, Hanglehm | Weathered / slope loam | `#7F7F7F` | `svg/geological_L.svg` |
| `Lx` | Hangschutt | Scree | `#7F7F7F` | `svg/geological_Lx.svg` |
| `Lg` | Geschiebelehm | Till loam | `#7F7F7F` | `svg/geological_Lg.svg` |
| `Mg` | Geschiebemergel | Till marl | `#41496C` | `svg/geological_Mg.svg` |
| `Lö` | Löss | Loess | `#69633E` | `svg/geological_Loe.svg` |
| `Löl` | Lösslehm | Loess loam | `#69633E` | `svg/geological_Loel.svg` |
| `Kl` | Klei, Schlick | Marine clay, silt | `#874680` | `svg/geological_Kl.svg` |
| `Wk` | Wiesenkalk | Lake marl | `#2F7DB7` | `svg/geological_Wk.svg` |
| `Bt` | Bänderton | Varved clay | `#675181` | `svg/geological_Bt.svg` |
| `F` | Mudde | Mud (gyttja) | `#874680` | `svg/geological_F.svg` |
| `A` | Auffüllung | Fill / made ground | `none (white)` | `svg/geological_A.svg` |
| `Krst` | Kreidestein | Chalk | `#2F7DB7` | `svg/geological_Krst.svg` |
| `Ktst` | Kalktuff | Calcareous tuff | `#2F7DB7` | `svg/geological_Ktst.svg` |

## 2. Consistency / density — `stratigraphy[].consistency_density`

**Example:** `"consistency_density": "dense"` → dicht, file `properties/density_dense.svg`, repeated down the layer's height right of the column: <img src="properties/density_dense.svg" height="40">

Rules:

- One field for both: fine soils have a consistency, coarse soils a density, so a layer has one or the other.
- The field is free text as printed (`"stiff"`, `"Medium Dense"`). Match it case-insensitively against the English or German term below. No match → no symbol (never guess).
- Careful with English terms: DIN *steif* is **firm**, DIN *halbfest* is **stiff** (BS 5930 wording).

| value (English) | Deutsch | symbol | file |
|---|---|---|---|
| `liquid` | flüssig | <img src="properties/consistency_liquid.svg" height="28"> | `properties/consistency_liquid.svg` |
| `very soft` | breiig/sehr weich | <img src="properties/consistency_very_soft.svg" height="28"> | `properties/consistency_very_soft.svg` |
| `soft` | weich | <img src="properties/consistency_soft.svg" height="28"> | `properties/consistency_soft.svg` |
| `firm` | steif | <img src="properties/consistency_firm.svg" height="28"> | `properties/consistency_firm.svg` |
| `stiff` | halbfest | <img src="properties/consistency_stiff.svg" height="28"> | `properties/consistency_stiff.svg` |
| `hard` | fest | <img src="properties/consistency_hard.svg" height="28"> | `properties/consistency_hard.svg` |
| `loose to very loose` | locker bis sehr locker | <img src="properties/density_loose.svg" height="28"> | `properties/density_loose.svg` |
| `medium dense` | mitteldicht | <img src="properties/density_medium_dense.svg" height="28"> | `properties/density_medium_dense.svg` |
| `dense` | dicht | <img src="properties/density_dense.svg" height="28"> | `properties/density_dense.svg` |
| `very dense` | sehr dicht | <img src="properties/density_very_dense.svg" height="28"> | `properties/density_very_dense.svg` |

## 3. Groundwater level — `groundwater[].type`

**Example:** `{"type": "strike", "depth_m": 1.80, "date": "2021-09-30"}` → open triangle, tip on the line at 1.80 m: <img src="left_symbols/groundwater_struck.svg" height="28"> 1.80 / (2021-09-30)

Rules:

- `depth_m` places the line (tip of the triangle on it), `date` goes under the line.
- One symbol per reading; a borehole can have several.
- The hours since drilling stopped (half-filled triangle, e.g. `3 h`) have **no field yet**.
- `rest` ↔ half-filled and `standpipe` ↔ filled is our reading of DIN 4023 §5.8 (filled = rest level in a built observation well); check with the team.

| `type` | symbol | DIN 4023 | file |
|---|---|---|---|
| `strike` | <img src="left_symbols/groundwater_struck.svg" height="24"> | struck while drilling; depth above the line, date in brackets below | `left_symbols/groundwater_struck.svg` |
| `rest` | <img src="left_symbols/groundwater_after_drilling.svg" height="24"> | level after drilling stopped (or after it changed); date in brackets + hours since drilling stopped | `left_symbols/groundwater_after_drilling.svg` |
| `standpipe` | <img src="left_symbols/groundwater_rest.svg" height="24"> | rest water level in an observation well (standpipe); date without brackets | `left_symbols/groundwater_rest.svg` |
| `other` | — | no DIN symbol: write the reading as text | — |

## 4. Groundwater rise / fall — derived from two `groundwater[]` readings

No own field: compare the `strike` reading with a later reading (`rest` or `standpipe`) of the same borehole.

**Example:** `strike` at 8.90 m, `rest` at 7.90 m → the water rose 1.00 m: arrow from 8.90 up to 7.90 <img src="left_symbols/groundwater_rise.svg" height="60">

| later reading vs. `strike` | symbol | file |
|---|---|---|
| shallower (smaller `depth_m`) | rise <img src="left_symbols/groundwater_rise.svg" height="40"> | `left_symbols/groundwater_rise.svg` (parts: `chevron_up.svg`) |
| deeper (larger `depth_m`) | fall <img src="left_symbols/groundwater_fall.svg" height="40"> | `left_symbols/groundwater_fall.svg` (parts: `chevron_down.svg`) |
| same depth | no arrow | — |

## 5. Cored section — `stratigraphy[].core`

**Example:** `"core": true` on the layer 6.70–10.00 m → double line left of the column from 6.70 to 10.00 m (one tile shown, repeat it in y): <img src="left_symbols/sample_cored.svg" width="22" height="10">

| `core` | drawn |
|---|---|
| `true` | `left_symbols/sample_cored.svg`, repeated in y over the layer's depth range |
| `false` / `null` | nothing |

Adjacent cored layers form one continuous line. TCR / RQD (`core_recovery_pct`, `rqd_pct`) exist only for cored layers.

## 6. Samples — `test_results[].sample_name` + `.sample_depth_m`

**Example:** `{"sample_name": "ES", "sample_depth_m": 3.0}` → black box, bottom edge at 3.00 m, line to the column, `ES` before the box: <img src="left_symbols/sample_sample.svg" height="28">

| field | drawn |
|---|---|
| `sample_depth_m` | bottom edge of the box and the line to the column |
| `sample_name` | text before the box |

DIN 4023 also wants the sampling category (A–E, written before the number: `A2`) and the sample's top **and** bottom depth: **no fields yet**, the model has one depth per sample.

## 7. Symbols with no field in the data model yet

The files exist; the data to pick them doesn't. Suggested fields, all on the layer unless noted:

| symbol | DIN 4023 | suggested field | values → file |
|---|---|---|---|
| weathering <img src="properties/weathering_w2_3.svg" height="28"> | Table 6 | `stratigraphy[].weathering` | `w0` (fresh (grade 0)) · `w1` (slightly weathered (grade 1)) · `w2_3` (moderately to highly weathered (grades 2-3)) · `w4` (completely weathered (grade 4)) · `w5` (residual soil (grade 5)) → `properties/weathering_<key>.svg` |
| jointing <img src="properties/jointing_jointed.svg" height="28"> | Table 6 | `stratigraphy[].jointing` | `jointed` · `highly_jointed` → `properties/jointing_<key>.svg` |
| wet <img src="properties/moisture_wet.svg" height="20"> | Table 6 | `stratigraphy[].wet` (bool) | `true` → `properties/moisture_wet.svg` |
| water sample <img src="left_symbols/sample_water_sample.svg" height="24"> | Table 5 | `test_results[].sample_type` = `water` | → `left_symbols/sample_water_sample.svg` (else `sample_sample.svg`) |
| sampling category | Table 5 | `test_results[].sampling_category` | `A`–`E`, written before the sample number |
| hours after drilling | Table 5 | `groundwater[].hours_after_drilling` | number, written after the date: `3 h` |
| joint dip <img src="left_symbols/joints_dip.svg" height="20"> | Table 5 | `joints[] {depth_m, dip_direction_deg, dip_deg}` (borehole level) | `left_symbols/joints_dip.svg` rotated by `dip_direction_deg` |
