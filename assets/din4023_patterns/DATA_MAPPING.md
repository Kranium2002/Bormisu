# DIN 4023 symbols and the data that draws them

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

## Samples — `test_results[].sample_type` (Table 5)

`sample_depth_m` places the symbol: its bottom edge sits at that depth.

| category | example |
|---|---|
| sample | `"soil"` → box <img src="left_symbols/sample_sample.svg" height="24"> |
| water sample | `"water"` → open triangle <img src="left_symbols/sample_water_sample.svg" height="24"> |

## Weathering — `stratigraphy[].weathering` (Table 6)

| category | example |
|---|---|
| weathering | `"w2_3"` → mäßig bis stark verwittert <img src="properties/weathering_w2_3.svg" height="36"> |

## Jointing — `stratigraphy[].jointing` (Table 6)

| category | example |
|---|---|
| jointing | `"jointed"` → klüftig <img src="properties/jointing_jointed.svg" height="36"> |

## Moisture — `stratigraphy[].wet` (Table 6)

| category | example |
|---|---|
| wet | `true` → nass <img src="properties/moisture_wet.svg" height="20"> |

## Joint dip — `joints[]` (Table 5)

| category | example |
|---|---|
| joint dip | `{"depth_m": 12.40, "dip_direction_deg": 135, "dip_deg": 25}` → <img src="left_symbols/joints_dip.svg" height="20"> rotated 135°, labelled `135 / 25` |

`sample_type`, `weathering`, `jointing`, `wet` and `joints[]` are new in the API contract (§4.13); the extractor doesn't fill them yet.
