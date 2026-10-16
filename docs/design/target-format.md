# Target format: Borehole Data Format

Source: `BoreholeDataFormat.xlsx`, provided by Herrenknecht with the challenge data (not in this repo; the field list below is our transcription).
Regulation referenced in the sheet: **DIN 4023**, see [din4023-cheatsheet.md](din4023-cheatsheet.md).

Every borehole we extract has to end up in this shape. It has three parts:
1. **Metadata:** one record per borehole.
2. **Log data:** one row per layer or sample, by depth.
3. **Test results:** optional, measured on samples.

## 1. Metadata (one per borehole)

| Field | Type | Unit | Notes |
|---|---|---|---|
| BoreholeID | alphanumeric | - | |
| BoreholeName | alphanumeric | - | |
| LocationName | alphanumeric | - | |
| StartDate | date | - | |
| EndDate | date | - | |
| ProjectID | alphanumeric | - | |
| ProjectName | alphanumeric | - | |
| Surface Elevation | numeric | mASL | Ground level above mean sea level |
| X-Coordinate | numeric | m / ° | Geographic or UTM |
| Y-Coordinate | numeric | m / ° | Geographic or UTM |
| CoordinateSystem | alphanumeric | - | Geographic / UTM / Gauss-Krüger / … |
| BoreholeDepth | numeric | m | **If the source is in ft, convert to m** |
| BoreholeLength | numeric | m | If ft, convert to m (differs from depth for inclined holes) |
| Notes | alphanumeric | - | |

## 2. Log data (per layer / depth interval)

| Field | Type | Unit | Notes |
|---|---|---|---|
| StratigraphicName | alphanumeric | - | e.g. formation name |
| EngineeringSoilUnit | alphanumeric | - | |
| GeologicAge | alphanumeric | - | |
| Lithology/SoilName | alphanumeric | - | e.g. "Kies, stark sandig" / "silty sand" |
| Soil/Rockprofile | color / pattern | - | DIN 4023 hatching + colour (see cheatsheet) |
| Core | boolean | yes/no | |
| SampleName | alphanumeric | - | |
| SampleDepth | numeric | m | |
| TotalCoreRecovery | numeric | % | TCR |
| RQD | numeric | % | Rock Quality Designation |
| SPT | numeric | n | Standard Penetration Test blow count (N) |
| Groundwaterlevel | numeric | m | |

Layer rows also carry their depth interval (from / to, in m), which every source log has.

## 3. Test results on samples (optional)

| Field | Type | Unit | Notes |
|---|---|---|---|
| Watercontent | numeric | % | |
| Consistency | numeric | % | (sheet spells it "Cosistency") |
| Unitweight | numeric | kN/m³ | |
| UCS | numeric | MPa | Uniaxial compressive strength |
| Tensile strength | numeric | MPa | |
| CAI | numeric | - | Cerchar Abrasivity Index |
| RMR | numeric | - | Rock Mass Rating |
| Q | numeric | - | Q-system |
| GSI | numeric | - | Geological Strength Index |
| FrictionAngle | numeric | ° | |
| Cohesion | numeric | kPa | |
| Grainsize-fines | numeric | % | |
| LiquidLimit | numeric | % | |
| PlasticityLimit | numeric | % | |
| PlasticityIndex | numeric | - | |
| ConsistencyIndex | numeric | - | |
| HydraulicCoefficient | numeric | m/s | |
| E-Modulus | numeric | MPa | |
| PoissonsRatio | numeric | - | |
| … | | | The sheet ends with "…", so the list is open-ended |

## What this means for the app

- **Normalisation is mandatory.** Every sampled log is metric, but keep ft→m detection anyway. The real variety is depth below ground vs elevation (many local datums) and about 10 coordinate systems. The UI should show the original value next to the normalised one.
- **The "Soil/Rockprofile" field is visual.** Each layer maps to a DIN 4023 hatching pattern and colour, which is what the LGRB profile column draws.
- **Most fields will be empty for most boreholes.** The UI needs a clear way to show "not found in source" as distinct from "0".
