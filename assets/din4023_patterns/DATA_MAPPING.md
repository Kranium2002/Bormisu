# DIN 4023 symbols and the data that draws them

One group = one variable of the borehole record (`docs/design/api-contract.md`): the value of that field picks the symbol.
Every category of a group is shown with one example. How to draw the files is in [README.md](README.md); all values are in `din_codes.json`, `properties.json` and `left_symbols.json`.

## Lithology fill — `stratigraphy[].din4023_code` (Tables 1–3)

| category | example |
|---|---|
| soil | `"G"` → Kies / gravel, `#DBAB06` <img src="svg/soil_G.svg" height="36"> |
| rock | `"Kst"` → Kalkstein / limestone, `#2A4C67` <img src="svg/rock_Kst.svg" height="36"> |
| geological | `"Mg"` → Geschiebemergel / till marl, `#41496C` <img src="svg/geological_Mg.svg" height="36"> |

## Consistency / density — `stratigraphy[].consistency_density` (Table 6)

| category | example |
|---|---|
| consistency | `"stiff"` → halbfest <img src="properties/consistency_stiff.svg" height="36"> |
| density | `"dense"` → dicht <img src="properties/density_dense.svg" height="36"> |

## Groundwater — `groundwater[].type` (Table 5)

| category | example |
|---|---|
| struck | `"strike"` → <img src="left_symbols/groundwater_struck.svg" height="24"> |
| after drilling | `"rest"` → <img src="left_symbols/groundwater_after_drilling.svg" height="24"> |
| rest level (well) | `"standpipe"` → <img src="left_symbols/groundwater_rest.svg" height="24"> |
| rise | strike 8.90 m, later reading 7.90 m → <img src="left_symbols/groundwater_rise.svg" height="48"> |
| fall | strike 7.90 m, later reading 8.90 m → <img src="left_symbols/groundwater_fall.svg" height="48"> |

## Cored section — `stratigraphy[].core` (Table 5)

| category | example |
|---|---|
| cored | `true` → double line over the layer <img src="left_symbols/sample_cored.svg" width="22" height="10"> |

## Samples — `test_results[].sample_depth_m` (Table 5)

| category | example |
|---|---|
| sample | `3.0` → box, bottom edge at 3.00 m <img src="left_symbols/sample_sample.svg" height="24"> |
| water sample | no field yet → <img src="left_symbols/sample_water_sample.svg" height="24"> |

## No field in the data model yet (Tables 5, 6)

| category | example |
|---|---|
| weathering | `w2_3` → <img src="properties/weathering_w2_3.svg" height="36"> |
| jointing | `jointed` → <img src="properties/jointing_jointed.svg" height="36"> |
| moisture | wet → <img src="properties/moisture_wet.svg" height="20"> |
| joint dip | `135 / 25` → <img src="left_symbols/joints_dip.svg" height="20"> rotated 135° |
