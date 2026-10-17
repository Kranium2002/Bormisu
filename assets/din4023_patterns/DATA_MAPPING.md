# DIN 4023 symbols and the data that draws them

One group = one variable of the borehole record (`docs/design/api-contract.md`): the value of that field picks the symbol.
How to draw the files is in [README.md](README.md); all values per group are in `din_codes.json`, `properties.json` and `left_symbols.json`.

| group | variable | example |
|---|---|---|
| lithology fill (Tables 1–3) | `stratigraphy[].din4023_code` | `"G"` → Kies / gravel, `#DBAB06` <img src="svg/soil_G.svg" height="36"> |
| consistency / density (Table 6) | `stratigraphy[].consistency_density` | `"dense"` → dicht <img src="properties/density_dense.svg" height="36"> |
| groundwater level (Table 5) | `groundwater[].type` | `"strike"` → struck <img src="left_symbols/groundwater_struck.svg" height="24"> · `"rest"` → half-filled · `"standpipe"` → filled |
| groundwater rise / fall (Table 5) | two `groundwater[]` readings | strike 8.90 m, rest 7.90 m → rise <img src="left_symbols/groundwater_rise.svg" height="48"> |
| cored section (Table 5) | `stratigraphy[].core` | `true` → double line over the layer <img src="left_symbols/sample_cored.svg" width="22" height="10"> |
| samples (Table 5) | `test_results[].sample_depth_m` | `3.0` → box, bottom edge at 3.00 m <img src="left_symbols/sample_sample.svg" height="24"> |
| weathering (Table 6) | no field yet | `w2_3` → <img src="properties/weathering_w2_3.svg" height="36"> |
| jointing (Table 6) | no field yet | `jointed` → <img src="properties/jointing_jointed.svg" height="36"> |
| moisture (Table 6) | no field yet | wet → <img src="properties/moisture_wet.svg" height="20"> |
| water sample (Table 5) | no field yet | → <img src="left_symbols/sample_water_sample.svg" height="24"> |
| joint dip (Table 5) | no field yet | `135 / 25` → <img src="left_symbols/joints_dip.svg" height="20"> rotated 135° |
