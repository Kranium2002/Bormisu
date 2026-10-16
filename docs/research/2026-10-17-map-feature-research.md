# Map feature research: what to build on the Bormisu map before Sunday

Date: Sat 17 Oct 2026, written overnight. Scope: 12 candidate "map" features plus one added item (13, predicting the subsurface at a clicked point). All persona evidence comes from our **simulated** persona study (AI role-play, not interviews); it is marked [P]. Everything else cites the numbered sources in section 5. Where a statement is my own judgement, it says so.

## 1. Summary

| # | Feature | Verdict | Value | Theory fit | Feasibility by Sunday | Confidence |
|---|---|---|---|---|---|---|
| 1 | Depth slider | **Build lite**: "ground at tunnel level" pin colours, no interpolation | Medium | Poor as a depth slice; fine per borehole in elevation | 3–5 h on top of 13 | Medium |
| 2 | 3D borehole sticks | Roadmap | Low–medium | OK | 12–20 h, new map stack, GPU/CI risk | High |
| 3 | Drill-down flythrough | Drop | Very low | n/a (eye candy) | 8–12 h after 2 | High |
| 4 | Draw your tunnel → section | **Build lite**: borehole-only section along a drawn line, no lines between holes | **Highest** | Good if no interpolation | 8–12 h (6–8 h if 13 is built first) | High |
| 5 | TBM simulator lite | Drop | Negative | Fails: our data lacks the model inputs | Possible to fake, shouldn't | High |
| 6 | Ground-risk heatmap | Drop | Negative | Fails: interpolates sparse, mixed-standard data | 4–6 h (cheap and wrong) | High |
| 7 | Similar-ground finder | Roadmap | Medium (needs project outcomes) | Weak across standards | 5–8 h | Medium |
| 8 | Scan peek on hover | **Build now** | High (core promise) | Good | 2–4 h | High |
| 9 | Ask the map (LLM) | Roadmap | Low–medium | OK only with schema-constrained output and visible filters | 6–10 h, needs a key, hard to test offline | Medium |
| 10 | Data-gap map | **Build lite** inside 4: gaps along the line; no "drill here" | Medium–high | OK as distance to evidence; "drill here" is not | +2–3 h on 4 | Medium |
| 11 | One-click tender brief PDF | Roadmap (print the section from 4 if time) | High for bid persona | OK with coverage stamp | Full 12–16 h; print-CSS lite 2–4 h | Medium |
| 12 | AR on a phone | Drop | Low | Poor: phone GPS/heading error, no iOS WebXR | 15–30 h | High |
| 13 | Predict the subsurface at a clicked point | **Build lite**: "nearest evidence here", k nearest columns + neighbour range + refusal rules; never one predicted profile | High as screening | Indefensible as prediction at our density; fine as nearest-evidence display | 6–9 h | High |

**Recommendation.** Build 8 (scan peek) first: 2–4 h for features that make "every number has a page behind it" visible on the map. Then build one shared, unit-tested "evidence near a location" module and put it behind 13-lite (click a point, see the nearest real boreholes and their range) and 4-lite (draw a line, see a borehole-only longitudinal section with mixed-face and gap flags). The section is what four of five personas asked for and what DAUB puts at the centre of TBM selection [1]. Add 1-lite (pin colours for the tunnel band) only if time is left. Don't interpolate between boreholes anywhere in the UI, and don't estimate cutter wear or "risk".

## 2. Methodology

1. **Internal context.** I read the challenge brief, target format and data inventory (19 sources, about 300 boreholes, 18 countries, about 8 datums and 10 CRSs). I read the persona study on `origin/prada/design` (personas, backlog, build cut, five walkthroughs), the frontend `ARCHITECTURE.md`, `src/domain/types.ts`, `src/data/adapters.ts` (the backend record shape) and the sample generator. I did not open `data/`.
2. **External evidence**, ranked by source type:
   - Standards and guidelines: the DAUB TBM selection recommendations, which I read in full [1]; EN 1997-2 Annex B.3 through a secondary copy [5]; ASCE MOP 154 on geotechnical baseline reports (GBRs) [6]; the ITIG code [41].
   - Manufacturers: Herrenknecht product pages [2][3] and Robbins/Afcons field experience [4].
   - National surveys: TNO GeoTOP [10], BGS LithoFrame and Groundhog [11–14], LGRB [18][19].
   - Peer-reviewed or conference papers on geostatistics, ML lithology prediction, cutter wear and AR.
   - Official library and vendor docs: Turf, MapLibre, deck.gl, Cesium, OpenAI/Anthropic structured outputs, ARCore.
3. **Five lenses per feature:** user value, theoretical validity, feasibility in our stack and data, trust risk, and demo value.
4. **Source quality.** Several primary sources are paywalled (Springer, ASCE, the EN text). Where I relied on a secondary copy or a search summary, the citation says so. Effort estimates are my judgement for one strong developer, including unit tests.

### Facts about our own stack that drive most verdicts

- **No lab test values reach the frontend.** The backend record (`ApiBoreholeRecord` in `src/data/adapters.ts`) carries layers (lithology, DIN code, SPT, TCR, RQD), groundwater readings, rock head and metadata. `geotechnical_tests` holds only `water_table_m`. UCS, CAI, fines, permeability and E-modulus exist only as column names in the export schema (`src/schema/targetFormat.ts`). So nothing on the map can use them yet.
- **Surface elevation is a string in `values` (`K.elevation`), not a typed field.** The sample data stores it as "m NN" with the note "datum stored as printed, unconfirmed". Any elevation-based feature has to parse it and handle "missing" and "datum unconfirmed".
- **The sample data has no spatial structure.**
  - In `src/sample/generate.ts`, every borehole draws its layer thicknesses, groundwater depths and surface elevation (`R(32, 240)` m) from its own RNG seed.
  - Inside one project, holes 1–2 km apart therefore differ by up to about 200 m in ground level and have unrelated layer sequences.
  - Any section, slice or "prediction" demo on this data will look random. **A spatially coherent fictional demo project is a precondition for 1, 4 and 13** (about 1–2 h, inside `src/sample/` only).
- **The map is Leaflet 1.9**, which is 2D only. Uncommitted helpers already exist in `src/geo/polygon.ts`: point-in-polygon, a distance-to-outline function, and a box helper.

## 3. Features

### Feature 1: Depth slider (horizontal slice)

**What engineers need.**
- The TBM persona's question is always "what is at tunnel level between km X and km Y?" [P-02]. They asked for "Colour by: rock type at tunnel level / reaches invert yes-no / max UCS in band" and a "Tunnel horizon only" filter in mASL [P-02].
- Three personas said colouring pins by final depth is useless to them [P-01, P-02, P-05]. The backlog records that nobody wanted colour by depth as the default [P-backlog].
- Prior art exists. TNO's GeoTOP voxel model is sliced horizontally relative to NAP, the Dutch datum (an elevation), not depth below ground [10]. BGS offers horizontal slices through its LithoFrame models [11][13]. Both slice a **3D model**, not raw boreholes.

**Where the theory breaks.**
1. **Depth vs elevation.** "10 m below ground" is not a geological horizon or a tunnel horizon. Tunnels are designed in elevation, and ground level varies.
   - The TBM persona says it directly: "a 60 m hole can still stop short of the tunnel" where the ground rises [P-02].
   - The LGRB profile axis itself is in m ü. NN, an elevation (context/reference-site.md).
   - In our data, elevations sit on about 8 local datums and are often unconfirmed (data inventory), so a cross-project elevation slice compares numbers on different zero points.
2. **"Not reached" is not "soil".** A borehole that ends at 12 m says nothing about 20 m. This is censored data. The pin must show "not reached", not a soil colour.
3. **A coloured pin set invites mental interpolation**, even with no interpolation drawn. Our pins in a project sit 1–2 km apart (sample) or in clusters thousands of km apart (real data).
4. **SPT refusal is not "rock".**
   - Refusal is a stopping rule: about 50 blows in one 150 mm increment, 100 blows in total, or no advance over 10 blows. Secondary sources disagree on the exact 100-blow scope [40].
   - Refusal can mean a boulder, cemented layer or rock head. Our app already says this in the demo script [P-build-cut].

**Lite version that fixes the theory.**
- Add a "Colour by" dropdown with three options: review status (default), "ground in tunnel band", and "reaches band".
- The user enters a band:
  - **Elevation mode** (crown/invert in m, same datum as the project), the default when every borehole of the project has a surface elevation on a single stated datum.
  - **Depth mode**, the fallback, with a banner: "Depth below ground, not a horizon: holes at different ground levels are not comparable."
- Each pin then gets one of six classes, computed from that borehole alone:
  - soil only in band
  - rock only in band
  - **rock head inside band (mixed face at this hole)**
  - SPT refusal in band
  - not reached (final depth above band)
  - no elevation / datum unconfirmed (grey, excluded)
- A slider for the band is fine, as long as it moves a band and not a "slice of the subsurface".

**Feasibility.**
- 3–5 h on top of the elevation parsing that 13 needs anyway, or 5–7 h standalone.
- Pure function `classifyBand(b, band, mode)` plus tests, a legend, and a dropdown in `MapLegend`.
- No backend change, since layers, rock head and groundwater are already on `Borehole`.

**Trust risk and mitigation.**
- Risk: a uniformly coloured cluster reads as "the ground here is rock".
- Mitigation:
  - Make "not reached" and "no datum" visually loud.
  - Show the count ("7 holes in band · 2 not reached · 3 without elevation").
  - Click-through goes to the profile with the band drawn on it.

**Demo value.** Medium. It is quick to show and lands well if it uses the same band as the section (feature 4).

**Verdict: Build lite** (as "Colour by: ground in tunnel band"), after 13 and 4. Drop the "subsurface slice" framing.

### Feature 2: 3D borehole sticks

**What engineers need.**
- None of the personas asked for 3D. They asked for sections and tables [P-backlog].
- Professional 3D exists. Leapfrog Works builds implicit 3D ground models from boreholes and cuts sections along tunnel alignments [15][16]. GeoTOP and BGS publish 3D models with synthetic boreholes and slices [10][11]. Engineers who need 3D already have those tools.
- Our value is the extraction feeding them (Bentley's own workflow imports borehole data from OpenGround into Leapfrog Works [49]), not another 3D viewer.

**Theory.** Sticks at true positions are honest, because no interpolation is involved. But the vertical exaggeration needed to see a 20 m stick on a map spanning km distorts geometry. Without elevation on a common datum, sticks hang from the wrong height.

**Feasibility.**
- Leaflet cannot do 3D, so we would need MapLibre GL (pitch up to 85° since v2 [30]) plus deck.gl layers interleaved into its WebGL context [31]. That is a second map engine next to Leaflet, or a migration.
- Rendering **below** the basemap is the hard part.
  - Cesium has explicit underground support (globe translucency; back and front faces swap when the camera is underground) [32].
  - For deck.gl on MapLibre, I found no documentation of how the shared depth buffer treats geometry below the ground plane. My judgement: expect occlusion work, or hang the sticks upward or with a translucent basemap.
- Our Playwright e2e runs headless and stubs tiles. WebGL in CI is another failure point for the AI code judge.
- 12–20 h.

**Trust risk.** Low if positions are confirmed. 3D gives an impression of a "model" that doesn't exist.

**Demo value.** High eye candy for the "presentation" 20%, but it competes with features that show problem understanding.

**Verdict: Roadmap.** If it is ever built, use Cesium or deck.gl in a separate project view, not on the world map.

### Feature 3: Drill-down flythrough

**What engineers need.** Nothing. No persona, standard or tool I found treats a camera dive as a work step. The bid manager drops tools that need more than a few clicks [P-05].

**Theory and trust.** Pure presentation. It adds nothing a profile column doesn't already show better.

**Feasibility.** 8–12 h on top of feature 2.

**Verdict: Drop.**

### Feature 4: Draw your tunnel → longitudinal section

**What engineers need.**
- Four of five personas asked for this, ranked #6 overall and the lead roadmap item [P-backlog, P-build-cut].
- The geotechnical engineer builds this picture by hand in Excel or CAD today (3–4 h) [P-01]. The senior geologist sketches a section to check whether rock head makes sense across neighbours [P-03].
- DAUB's seven-step TBM selection starts from the geotechnical report's homogeneous zones "in the geotechnical longitudinal section". It ends with the tunnel longitudinal section divided into tunnelling sections, which "can also be used as the technical and estimate basis for contracts" [1, §4.1, §4.7].
- DAUB's worked example defines mixed face exactly as the stretches where "the tunnel horizon intersects the boundary between the layers" [1, Appendix A].
- Prior art: Leapfrog Works alignment serial sections [15], BGS Groundhog fence diagrams of interlocking sections [14], and gINT/OpenGround-style fence outputs (not verified in this session).

**Where the theory breaks.**
1. **Interpolated lines between boreholes are interpretation.**
   - DAUB assigns the homogeneous-zone proposal to the geotechnical report, i.e. to a qualified person [1, §4.1].
   - ASCE MOP 154 separates the factual data report from the interpretive baseline report. Where a tunnel crosses several regimes, it prefers describing each reach over averaging along the alignment [6].
   - A tool that draws a smooth rock-head line through holes 400 m apart is doing the geologist's job without the geologist.
2. **Mixed face is a property of the face, not of a borehole.**
   - Robbins/Afcons define it as a face "partially in both rock and soil". On one Chennai drive, 187 m of mixed face cost 144 cutter changes [4].
   - Search results report that a Herrenknecht presentation says the industry has no shared definition of mixed ground. I could not open the source, so treat that as unverified.
   - We can only flag "rock head inside the tunnel band **at this borehole**".
3. **Elevation is required.** The tunnel is defined in elevation [P-02]. Holes without surface elevation, or with an unconfirmed datum, can't be placed on the section. They must be shown as "not placeable", not silently dropped.
4. **Projection onto the line.** Boreholes off the line are projected by chainage. If geology varies across the line, projection misleads. Show the offset and limit the corridor.
5. **Groundwater.** Readings are point-in-time (strike vs rest vs standpipe). A "groundwater line" joining them mixes types and dates. Draw markers per reading type, not a line.

**Lite version that fixes the theory.**
- The user draws a polyline: click points on the Leaflet map, with no extra library (Leaflet-Geoman is an option if editing is needed). They set a corridor (±100 m default, editable) and a tunnel band (crown and invert elevation, or depth fallback).
- Boreholes in the corridor of the same project become DIN 4023 sticks on a chainage × elevation SVG, reusing `ProfileColumn` drawing logic. Each stick shows its offset label and source link.
- **No lines between holes**, apart from optional dashed straight segments labelled "linear connection, not interpreted".
- Per-hole flags:
  - rock head in band (mixed face here)
  - refusal in band
  - water above crown (per reading type)
  - not reaching invert
- A **gap bar** under the axis marks stretches with no borehole within R of the line (feature 10-lite).
- Footer: "Boreholes as logged. Lines between holes are not a ground model. Coverage: 9 of 12 holes placed; 3 without elevation."

**Feasibility.**
- 8–12 h standalone, 6–8 h if the module from 13 exists.
- Parts: chainage projection (pure function, testable), draw mode, section SVG, band input, flags. No backend change.
- **Needs the coherent demo project** described in section 2.
- Real data from one report usually shares a datum, so within-project sections work when elevations were extracted.

**Trust risk and mitigation.**
- Risk: the picture looks like a geological section and gets screenshotted into a tender.
- Mitigation:
  - No interpolated fills.
  - Dashed and labelled connectors only.
  - A coverage stamp.
  - "Approved only" by default, matching the export rules.
  - Every stick links to its source page.

**Demo value.** Highest of all candidates. It shows problem understanding (DAUB workflow, mixed face, tunnel horizon) and gives a visual payoff. It also turns the map from a "demo screen" [P-01, P-03] into a work tool.

**Verdict: Build lite.**

### Feature 5: TBM simulator lite (cutter-wear meter)

**What engineers need.** Cutter consumption is a priced line in the offer [P-02]. It is the TBM engineer's own expertise, done in their Excel and Python wear models. What they asked us for is clean, traceable inputs per chainage: "Give me UCS, CAI and RQD at tunnel level along the chainage, with the n and the source page behind every number, in a CSV my wear model reads" [P-02].

**Where the theory breaks.**
- **The established models need inputs we don't have.**
  - Gehring relates specific cutter weight loss to CAI, built from project data [8].
  - The CSM model (Rostami) uses CAI for basic cutter life, plus rock strength and machine parameters [8].
  - The NTNU model uses lab indices CLI and DRI (from Sievers' J, AVS and S20 tests), plus a fracturing class and machine data [7][9].
  - For soil, DAUB lists LCPC abrasivity (ABR), breakability, equivalent quartz content, cobble and boulder content, and boulder CAI [1, Appendix 2]. It also notes the LCPC test "is disputed among industry experts" [1, §6.3.2].
- Our frontend has none of UCS, CAI, CLI, quartz or ABR (section 2).
- Reviews describe the accuracy of wear models as "not currently satisfactory" [8], and Bruland himself argued a model needs revision every 8–10 years [9].
- **What engineers would think, in my judgement:** a cartoon wear meter in front of Herrenknecht engineers says we don't know what their job involves. Herrenknecht itself works on in-situ cutter force and wear sensing [46][47], so the real state of the art is measurement, not cartoons.

**Feasibility.** A toy is 8–12 h. Real inputs depend on lab-table extraction, which is on the roadmap [P-build-cut].

**Trust risk.** Severe. It is false precision on the most commercially sensitive number.

**Verdict: Drop.** Roadmap item instead: "Ground parameters per chainage → tidy CSV for your wear model" once lab tables are extracted.

### Feature 6: Ground-risk heatmap

**What engineers need.** Tender risk and contingency matter [P-05]. The professional route is DAUB tunnelling sections and the ITIG risk-management code's risk registers [1][41]. The bid manager wanted a "worst ground" list "with the borehole and depth it comes from" [P-05]. That is a list with evidence, not a surface.

**Where the theory breaks.**
- A heatmap is interpolation of a derived score. It inherits all the problems of feature 13 (sparse, clustered data, nugget-heavy variability, mixed classification standards). It adds an arbitrary scoring function on top.
- Turf's `interpolate` is plain IDW with weight exponent 1 by default [29]. It runs in a few lines, which makes the result easy to build and easy to get wrong.
- Kriging-style smoothness assumes stationarity within one geological domain. Faults, channels and karst violate it (see 13).

**Feasibility.** 4–6 h, which is the trap.

**Trust risk.** It is the most direct contradiction of "every number traceable to its source". A shaded pixel has no source page.

**Verdict: Drop.** Instead, put per-borehole hazard flags on the section (feature 4) and a "worst ground" list with source links (roadmap with feature 11).

### Feature 7: Similar-ground finder

**What engineers need.**
- The TBM engineer and the bid manager want reference projects: "Find similar ground", "projects in gneiss with UCS 100–200 MPa" [P-02, P-05].
- What makes a reference useful is the outcome: TBM type, diameter and actual cutter consumption. The schema has none of it, and the build cut already parked the feature for that reason [P-build-cut, P-05].

**Where the theory breaks.**
- Sequence similarity is a known problem. Dynamic time warping is used for well-log correlation, with documented problems: inconsistency across many wells, and several equally valid alignments [43].
- Our layer sequences come from logs written to DIN 4022/EN ISO 14688, USCS (ASTM D2487) and local practice, normalised by an LLM to DIN codes.
- USCS and ISO 14688 are close but differ in coding, in an intermediate-plasticity class, and in field identification [44].
- Similarity on our normalised codes therefore measures our mapping as much as the ground. In my judgement it is acceptable for "find holes that look alike" inside one report. It is weak across countries and standards.

**Feasibility.** 5–8 h: edit distance or DTW over sequences of main soil and rock type with thickness weights, plus highlighting.

**Trust risk.** Medium. "Similar" without a match reason and the source standard reads as authoritative.

**Verdict: Roadmap**, gated on project outcome fields.

### Feature 8: Scan peek on hover

**What engineers need.**
- Provenance on every value is the only need all five personas share [P-backlog].
- The senior geologist's deal-breaker is anything they can't trace [P-03]. The bid manager needs to back a number in a meeting [P-05].
- This puts the app's core promise onto the map at zero theory cost.

**Theory.** Holds. It shows the source; it estimates nothing.

**Feasibility.**
- 2–4 h.
- `Borehole.primaryPage` plus each value's `page` and `box` exist. API pages have `imageUrl`, and the sample pages are drawn.
- Use a Leaflet tooltip or popup with a cropped page region: the BoreholeID or header box, or the rock head value's box.
- Throttle image loads.
- In sample mode, render the drawn page crop.

**Trust risk.** Low. Show "box not found: page shown" exactly as the side panel does.

**Demo value.** High per second of pitch time. It is also a good place to show "Read / OCR / Guessed".

**Verdict: Build now.**

### Feature 9: Ask the map (natural language → filters)

**What engineers need.** Search exists today (project or ID). Persona wishes were concrete filter chips: parameter availability counts, "Unreviewed", "My batch", region chips [P-02, P-04, P-05]. Nobody asked for chat.

**Where the theory breaks.**
- Schema-constrained decoding makes output **valid**, not **correct**. OpenAI's strict structured outputs and Anthropic's structured outputs or strict tool use guarantee schema-conformant JSON [33]. A valid filter can still be the wrong one.
- On the BIRD text-to-SQL benchmark, GPT-4 reached 54.89% execution accuracy against 92.96% for humans [34]. Newer systems reportedly reach about 80%, which I couldn't verify.
- Our filter space is far smaller than SQL. Still, a silent wrong filter on a ground map is a trust failure.

**Lite version, if ever built.**
- The LLM returns a typed filter object.
- The UI renders it as editable chips before applying.
- Unknown terms produce "can't filter on X". Plausible but unsupported fields such as UCS are refused, never ignored.
- A rule-based fallback runs without a key, because the code judge runs without one.

**Feasibility.** 6–10 h including a backend endpoint, prompts, the offline fallback and tests. Live API risk during the pitch.

**Verdict: Roadmap.** Hand-made filter chips give the same demo value with no AI risk.

### Feature 10: Data-gap map and "drill here next"

**What engineers need.**
- Gaps decide contingency and the clarification questions sent to the client [P-05].
- The TBM engineer wants stretches "where nobody drilled to tunnel level" [P-02].
- The bid manager's "Data gaps" card means route sections with no borehole within 250 m, missing test types, and boreholes with a guessed CRS [P-05].

**Where the theory breaks.**
- **"Drill here next" is site-investigation planning.** EN 1997-2 Annex B.3 gives 20–200 m spacing for linear structures, including tunnels, as guidance only [5]. Actual planning depends on geology, structure and project phase.
- Kriging-variance-based placement exists in research [28]. But kriging variance depends only on data geometry, not on data values, so it is a poor reliability measure on its own [22].
- A tool proposing drill sites without geology or project context overreaches.
- A distance-to-nearest-evidence map is honest. It is the complement of feature 13's coverage zone.
- Global hex-bins across 18 countries mostly show which reports we were given, not which ground is unknown.

**Lite version.** Inside the section (feature 4), add two gap types:
- a bar for chainage stretches with no borehole within R of the line
- "no borehole reaches the invert here" marks

Add "Copy as clarification questions" to the existing open-questions export if time allows.

**Feasibility.** +2–3 h on feature 4.

**Verdict: Build lite inside 4.** Drop "drill here next".

### Feature 11: One-click tender brief (PDF)

**What engineers need.**
- The bid manager rates it "must" [P-05].
- GBR practice separates factual from interpretive and sets measurable baselines [6]. A brief built by a tool must therefore say what is factual and who interpreted it.
- The persona study's own rule: build it from approved fields with a template, never free LLM text, with a coverage stamp and a DRAFT watermark when unreviewed data is used [P-backlog conflicts].

**Theory.** OK if it summarises evidence, such as the section, hole counts and gaps. It turns risky when it states ground class shares ("40 % rock") that rest on interpolation between holes.

**Feasibility.**
- The full version is 12–16 h: it needs a project summary, ground class and tunnel horizon.
- A lite version is 2–4 h after feature 4: a print stylesheet for the section view plus a coverage and data-basis footer (browser "Save as PDF").

**Verdict: Roadmap.** Do the print-CSS lite only if 4 is done early.

### Feature 12: AR on a phone

**What engineers need.** No persona asked for it. On-site AR for buried assets exists, but serious products use external GNSS. Trimble SiteVision pairs the device with an external GNSS antenna and RTX correction to reach centimetre-level positioning [38].

**Where the theory breaks.**
- Phone GPS is "typically accurate to within a 4.9 m radius under open sky", and worse near buildings and trees [35].
- ARCore's geospatial sample only places anchors once horizontal accuracy is within 10 m and heading within 15° [36].
- A Utrecht thesis on mobile AR for underground infrastructure found orientation and GPS accuracy insufficient [39].
- Borehole positions in our data carry CRS uncertainty on top of that.
- iOS Safari does not support WebXR `immersive-ar` (secondary sources, 2026) [37].

**Verdict: Drop.**

### Feature 13: Predict the subsurface at any clicked location ("virtual borehole")

The question is: "How viable is it to predict the ground at a place from the data points around it? Does that make sense?"

**Short answer.**
- **Across projects: no.** Our points are clusters hundreds to thousands of km apart, and no method is defensible there.
- **Inside a project cluster:** prediction is a well-studied geostatistical problem. But it needs far more boreholes than our projects have, a single datum, one classification standard, and a geologist's interpretation of discontinuities.
- At our density (sample: 4–14 holes per project, about 1–2 km apart; real reports: 1 to about 75 holes per report, most between 6 and 30, per our data inventory), the honest product is **"nearest evidence at this point, with the spread between neighbours"**, not a predicted profile.
- That version is useful for tender-phase screening, and we can build it by Sunday.

#### 13.1 What "predicting a borehole" actually means

It is two different estimation problems:
1. **Continuous surfaces:** rock head, groundwater head, top of a unit. Estimate a number (an elevation) at (x, y). Methods: IDW, kriging, RBF/implicit surfaces.
2. **Categorical sequences:** the lithology column. Estimate which class occurs at each (x, y, z), and in what order. Methods: indicator kriging and simulation, transition probabilities, implicit modelling of contacts, ML classifiers.

A "virtual borehole" combines both. Most error lives in problem 2.

#### 13.2 Methods used in practice and research

| Method | What it does | Assumptions / needs | Where it is used | Uncertainty output |
|---|---|---|---|---|
| Nearest neighbour (Thiessen) | Copies the closest log | Ground near the closest hole resembles it | GeODin's "Virtual Log → Nearest Borehole" copies the closest log's layers into an **editable** virtual log. Its docs warn it gives "a misleading starting point" if the location is geologically different [17] | None |
| Inverse distance weighting (IDW) | Weighted mean of neighbours for a continuous value | No stationarity model; weight exponent chosen by hand; can't extrapolate beyond data range | Turf `interpolate` (default exponent 1) [29]; quick contouring | None built in. Leave-one-out cross-validation is possible |
| Ordinary / universal kriging | Best linear unbiased estimate from a fitted variogram | Second-order stationarity in a domain; enough pairs to estimate the variogram. Webster & Oliver recommend about 100–150 sample sites for a reliable method-of-moments variogram (via a secondary citation) [23] | Rock-depth mapping, e.g. 652 boreholes over about 220 km² in Bangalore [48]; Norwegian sediment thickness [25] | Kriging variance. It depends only on data geometry, not on the values, so it is a weak reliability measure on its own [22] |
| Indicator kriging / sequential indicator simulation (SIS) | Probability of each lithology class; simulation gives many equally likely columns | One indicator variogram per class; anisotropy; poorly defined with sparse wells (Journel 1983, Math. Geol. 15(3); [20]) | Hydrofacies and lithofacies models | Class probabilities and realisations |
| Transition probability / Markov chain (T-PROGS) | Models juxtaposition tendencies, e.g. fining-upward sequences | Proportions and mean lengths per class; 3D Markov chains (Carle & Fogg 1996, 1997) [21] | Hydrogeology (GMS T-PROGS) [21] | Realisations |
| Implicit modelling (RBF) | Fits a volume function whose zero isosurface is a contact | Interpreter controls trends, faults and contact rules; fast RBF interpolation (Cowan et al. 2003) [16] | Leapfrog Works for tunnels and civil work [15][16] | Scenario comparison and validation against new data [49]. No built-in probabilistic bounds that I could find |
| Explicit section-based modelling | Geologist draws correlated sections; model built from fences | Expert correlation | BGS GSI3D/Groundhog [14]; most GBR longitudinal sections | Qualitative |
| ML classifiers (random forest, gradient boosting, neural nets; Gaussian processes) | Predict class from (x, y, z, elevation, …) | Large labelled data sets. Tree models reported best among ML for Singapore stratigraphy [27]; ensemble "virtual boreholes" [27] | Research; some national surveys | Class probabilities or entropy. In 1,400 Dutch boreholes, models reached 75–80% accuracy, but only about 65% of random-forest transitions were geologically plausible (neural nets up to 96%) [26] |

**National models that do this from borehole databases.**
- **TNO GeoTOP** (Netherlands, via DINOloket).
  - Built from DINO borehole data.
  - Stratigraphic surfaces first, then indicator simulation of lithoclasses inside each unit.
  - Voxels of 100 × 100 × 0.5 m down to 50 m below NAP.
  - **Each voxel stores the most likely class plus probabilities per class**, which serve as the uncertainty measure [10].
  - This is the best example of honest uncertainty communication. It took a national borehole database and a national survey to build.
- **BGS LithoFrame** (UK).
  - 3D models at site, corridor and regional scale, built 2003–2018.
  - GeoIndex lets users create cross-sections, **synthetic boreholes** and horizontal slices [11][13].
  - BGS itself writes that the model is "not easy to assess in terms of uncertainty", and that a borehole map does not convey log depth, log quality or coding reliability [12].
- **LGRB** (Baden-Württemberg).
  - The GeORG 3D model (2008–2013) is a structural model of the Upper Rhine Graben down to about 7 km, labelled an unpublished working state [19].
  - LGRBbohrungen offers borehole search with depth filters and profile downloads [18].
  - I found no shallow engineering-scale "virtual borehole" product from LGRB. The likely reason is the order of magnitude: a structural model to 7 km is a different product from a 20 m engineering profile.

Pattern across surveys: where synthetic boreholes are offered, they sample a **curated 3D model** built by geologists from dense data. They don't interpolate raw boreholes on click.

#### 13.3 When it makes sense and when it does not

1. **Density vs correlation length.**
   - Horizontal correlation in soils is much longer than vertical, often quoted as 40–60× [24].
   - Even so, the small-scale (nugget) share can be large. In Norwegian sediment thickness from a national well database, about 50% of the variance was small-scale, and co-kriging improved accuracy only marginally [25].
   - Variogram estimation needs on the order of 100+ points [23]. With 4–14 holes per project, a variogram can't be estimated, so "kriging" would rest on an assumed variogram, i.e. on our guess.
   - **Judgement:** with fewer than about 20–30 holes in one geological domain, prefer showing neighbours over estimating.
2. **Spacing vs standard practice.**
   - EN 1997-2 Annex B.3 suggests 20–200 m between investigation points for linear structures including tunnels. That is guidance, not a rule, and the clause is numbered differently in the 2024 edition [5].
   - A point more than 200 m from any borehole lies outside what a standard investigation would consider covered.
   - **I use R = 200 m as the default refusal radius**, anchored to that range. This is my judgement; make it editable.
3. **Discontinuities break all interpolators.**
   - Faults, buried channels, karst, glacial deposits with boulders, and weathering fronts in granite with corestones, and karst (Herrenknecht's Kuala Lumpur project bored karstic limestone in mixed-face conditions [3]) produce exactly the surprises a tunnel fears.
   - Interpolators smooth them away. Implicit modelling handles faults only when a geologist draws them [16].
4. **Elevation, not depth.**
   - Interpolate rock head and groundwater as **elevations** on one datum.
   - Interpolating depth below ground transfers the topography into the geology.
   - Groundwater must be compared as head of the same reading type and similar dates. Strike, rest and standpipe readings are different things.
5. **Censored observations.** A hole ending at 18 m in soil says "rock head below 18 m". IDW and kriging can't use an inequality without special handling; dropping the hole biases rock head upward. Show it as a bound.
6. **Extrapolation.** Outside the convex hull of the data, kriging reverts to the mean and IDW to the nearest values. Neither has support there. Refuse.
7. **Clustered data.**
   - Our real dataset is 19 reports in 18 countries.
   - The sample data has 7 projects in Germany, with holes on a 1–2 km ring around each project centre.
   - Cross-project estimation is meaningless. Within a cluster it is a question of density and geology (points 1–3).
8. **Mixed classification standards.**
   - Lithology from different standards, mapped by an LLM to DIN codes, adds category noise (feature 7, [44]).
   - Categorical prediction should stay inside one report, one standard and one logging contractor.
9. **Our own pipeline uncertainty.** An inferred CRS can shift a hole by hundreds of metres or kilometres (persona 01's "500 m off in the right city" [P-01]), and the datum may be unconfirmed. Unconfirmed holes must not drive an estimate.

**Is it scientifically defensible?**
- **Across projects km apart:** no.
- **Within a project cluster:**
  - As **"nearest evidence plus the spread between neighbours"**: yes.
  - As a single predicted column: no at our density. Only with dense, single-datum, single-standard data and a geologist-defined domain, which describes GeoTOP or a Leapfrog project, not a tender folder.

#### 13.4 Professional and legal framing

- **A predicted profile can't replace investigation.** EN 1997-2 frames investigation as points in the ground at spacings and depths set by the structure and the geology [5]. A synthetic column is not an investigation point.
- **GBR practice.**
  - Baselines are contractual statements of expected conditions, kept separate from factual data [6].
  - If a tool-generated profile entered a tender as "expected ground", it could be read as a baseline, and the difference from reality becomes a claims question.
  - The ITIG code, which insurers use as a benchmark, is about managing exactly this risk [41].
  - Hong Kong's GEO notes that most tunnel failures are due to inadequacies in managing geotechnical risk [42].
- **Where it fits.** Tender-phase screening at the TBM supplier.
  - Herrenknecht receives the client's investigation and must quickly judge what it says, how well it covers the alignment, and what to ask the client [P-02, P-05].
  - "What do we expect here, and how sure are we?" answered as **evidence plus spread plus distance** supports TBM type pre-selection (DAUB step 1–3 [1]), contingency, and the request for more holes.
  - It doesn't support design.

#### 13.5 Hackathon lite version, concretely

**Interaction.** The user clicks a point on the map, or later a chainage on the section from feature 4. A side panel titled "Evidence near this point" opens.

**Algorithm.** Pure functions in a new `src/geo/nearby.ts`, unit-tested, next to the existing `src/geo/polygon.ts`:

1. **Candidates:** boreholes with `onMap`, coordinates not from an inferred CRS (or included with an amber flag), and the **same project** as the nearest borehole. Never mix projects.
2. **Distances:** haversine in metres.
3. **Refusal rules, checked in order:**
   - **Nearest > R** (default 200 m, editable): "No borehole within 200 m. Nearest: BK-07 at 640 m. A prediction here would not be supported by data."
   - **Outside the convex hull** of the project's holes plus a buffer of R/2: "Outside the investigated area."
   - **Only one hole within R:** show it alone and label "single source, no spread".
4. **Show the k = 3 nearest** within R as `ProfileColumn` sticks side by side, each with distance, direction, review status and a source link.
5. **Alignment.** Align the sticks on **elevation** if all have a parsed surface elevation on the same stated datum. Otherwise align on depth with a banner: "Aligned on depth: surface elevation missing or datum unconfirmed for BK-03."
6. **Summary lines** (ranges, not estimates):
   - Rock head: "reached in 2 of 3: 212.4–214.1 m [datum]; BK-09 ended in soil at 18.0 m (rock head below 196.0 m)."
   - Groundwater, per reading type: "rest level 3.1–4.0 m below ground (2 readings, dates)."
   - Hazards present in any neighbour: refusal at depth, boulders mentioned (if extracted).
7. **Optional, my recommendation:** no single "estimated" value. If one is wanted, show an IDW value next to the project's **leave-one-out error**, e.g. "IDW 213.2 m; in this project, predicting each hole from the others misses by up to 4.8 m". LOO with 5–14 holes is a weak check, but it is honest and computable in a few lines.
8. **Label, always visible:** "Indicative: nearest evidence, not a prediction. Not a substitute for ground investigation (EN 1997-2)."

**Data model fit.**
- `Borehole` has `lat`, `lng`, `onMap`, `crs.status`, `layers[]` (from/to, din, pattern), `rockHead`, `groundwater[]` and `finalDepth`/`logBottom`.
- The surface elevation must be parsed from `values` (`K.elevation`). Add a small `surfaceElevation(b): {value, datum, confirmed} | null` helper in `src/domain/`.
- No backend change.

**Hours.**

| Part | Effort |
|---|---|
| Geometry (haversine, convex hull, buffer, k-nearest) + tests | 1.5–2 h |
| Elevation helper + tests | 0.5–1 h |
| Panel UI reusing `ProfileColumn` | 2–3 h |
| Refusal and empty states, e2e test | 1 h |
| Coherent demo project in `src/sample/` | 1–2 h |
| **Total** | **6–9 h** |

Feature 4 then reuses steps 1–5 along a line.

**Failure modes to rehearse.**
1. Random sample elevations and layers make neighbours look unrelated. Fix this with the demo project.
2. A hole with an inferred CRS lands in the panel. It should be excluded or flagged amber.
3. Mixed datums inside one report, e.g. legacy holes on another datum. Detect by datum label and refuse elevation alignment.
4. A borehole name duplicated across reports. Possible double counting, so dedupe by position.
5. An inclined hole, where depth is not elevation difference. Flag it if `BoreholeLength ≠ BoreholeDepth`.
6. A point exactly at a borehole. Show that hole first, at "0 m".

**How to pitch it honestly, about 20 seconds.** "Engineers ask what is under a point between boreholes. We don't invent a profile. We show the nearest logged evidence, its spread and its distance. Beyond 200 m, the spacing ceiling of EN 1997-2 for linear structures, we say there is no data. That gap goes straight into the client clarification list."

#### 13.6 Cross-links

- **Feature 4 (section)** asks the same question along a line. Each chainage either has evidence within R of the line or is a gap. The rules for elevation, refusal, censoring and no-interpolation are identical, so build 13's module first.
- **Feature 6 (risk heatmap)** is feature 13 evaluated on a grid with a score on top. It inherits every failure in 13.3 at once, and so is dropped.
- **Feature 10 (data gaps)** is the refusal zone of feature 13 drawn as a map: the complement of "within R of a borehole".

## 4. Things we should NOT claim in the pitch

1. "We predict / model the geology between boreholes." We show logged evidence. Interpretation is the geotechnical report's job [1][6].
2. "Mixed face detected along the tunnel." We can only say "rock head inside the tunnel band at borehole X" [1][4].
3. "Cutter wear / cutter consumption estimate" or "TBM type recommendation." Wear models need CAI, UCS, CLI and more, which we don't extract yet [7][8][9]. TBM selection in DAUB also needs fines, permeability, consistency and water pressure [1, Appendix 3]. We can say our export feeds those workflows.
4. "Risk map" or "drill here next." That is site-investigation planning by a qualified person [5][28].
5. "SPT refusal = rock." Refusal is a stopping criterion and can be a boulder or cemented layer [40].
6. "Groundwater level along the tunnel." Readings are point-in-time and of different types.
7. "Elevations are comparable across projects." Our data spans about 8 datums, and many are unconfirmed (data inventory).
8. "DIN codes make logs from all standards equivalent." USCS, ISO 14688 and local practice differ [44].
9. "3 days → 6 hours, measured." These are simulated persona estimates; say "target" [P-build-cut].
10. "Our AI understands the ground" or confidence percentages as accuracy. A green 90% was wrong in the persona test [P-03]. Show methods (Read / OCR / Guessed), not percentages.
11. "A 3D model" (unless one exists), or "AR-ready".
12. "Global coverage." The map currently shows Germany for focus. The real data spans 18 countries in sparse clusters.

## 5. Sources

Internal (read-only, not public sources): [P] persona study on branch `prada/design`: `docs/personas/personas.md`, `feature-backlog.md` [P-backlog], `build-cut.md` [P-build-cut], walkthroughs 01–05 [P-01 … P-05]. All are **simulated** personas. Also `context/challenge-brief.md`, `context/data-inventory.md`, `context/target-format.md`, `context/reference-site.md`, `frontend/ARCHITECTURE.md`, `frontend/src/domain/types.ts`, `frontend/src/data/adapters.ts` and `frontend/src/sample/generate.ts`.

1. DAUB (German Tunnelling Committee), *Recommendations for the Selection of Tunnel Boring Machines*, Jan 2022, revised Aug 2025. https://www.daub-ita.de/fileadmin/documents/daub/gtcrec1/2025-08_Selection_of_Tunnel_Borng_Machines.pdf
2. Herrenknecht AG, EPB Shield product page. https://www.herrenknecht.com/en/products/productdetail/epb-shield/
3. Herrenknecht AG, Variable Density TBM product page. https://www.herrenknecht.com/en/products/productdetail/variable-density-tbm/ and press release on Kuala Lumpur karst/mixed face: https://www.herrenknecht.com/en/newsroom/pressreleasedetail/variable-density-technology-game-changer-for-kuala-lumpur/
4. Clark, J. (Robbins) & Verrall, P. (Afcons), "Tunneling in Mixed Face Conditions: An Enduring Challenge for EPB TBM Excavation", RETC 2019. https://www.robbinstbm.com/wp-content/uploads/2019/07/RETC2019-14-05_Tunneling-in-Mixed-Face-Conditions.pdf
5. EN 1997-2:2007 Annex B.3, spacing of investigation points (20–200 m for linear structures), read via secondary copy (GeoStru help): https://help.geostru.eu/git/en/annex-b_3-examples.html. Renumbering in the 2024 edition seen in the Cyprus National Annex draft: https://www.cys.org.cy/wp-content/uploads/2026/01/Παράρτημα-Α-Cyprus-National-Annex-1997-2-for-Public-Enquiry.docx. The official text was not accessed.
6. ASCE, *Geotechnical Baseline Reports: Suggested Guidelines*, MOP 154 (2022). https://ascelibrary.com/doi/10.1061/9780784416082.ch2. Summary: https://tunnelingonline.com/asce-manual-of-practice-154-provides-guidance-for-geotechnical-baseline-reports/ (full text not accessed; points taken from the summary and search snippets).
7. Nilsen, B., Dahl, F., Holzhäuser, J., Raleigh, P., "Abrasivity testing for rock and soils", *Tunnels & Tunnelling International*, 2006 (NTNU). https://bnilsen.folk.ntnu.no/T%26Tpart2_0406.pdf
8. Review of CSM, NTNU and Gehring cutter-wear models, "Cerchar abrasivity test and its applications in rock engineering", *Int. J. Coal Sci. Technol.* (2025). https://link.springer.com/content/pdf/10.1007/s40789-025-00787-0.pdf. Paywalled; equations taken from search summaries. See also the comparative study https://www.researchgate.net/publication/284850580_A_comparative_study_on_the_TBM_disc_cutter_wear_prediction_model
9. SINTEF/NTNU, DRI–BWI–CLI standard (2011). https://www.sintef.no/globalassets/sintef-byggforsk/berg-og-geo/dri-bwi-cli_standard-2011.pdf. Bruland's remarks on model revision are from a search summary of NTNU material.
10. TNO, GeoTOP product sheet. https://www.tno.nl/media/1688/productieblad_geotop_modellering.pdf. nlmod GeoTOP docs: https://nlmod.readthedocs.io/en/stable/data_sources/15_geotop.html. Zeeland GeoTOP paper (*Netherlands Journal of Geosciences*): https://resolve.cambridge.org/core/services/aop-cambridge-core/content/view/EAEB732365E64A198CBC3E10648B8F38/S0016774600000597a.pdf/3d-modelling-of-the-shallow-subsurface-of-zeeland-the-netherlands.pdf
11. BGS, LithoFrame 3D geological models (metadata). https://metadata.bgs.ac.uk/geonetwork/srv/api/records/19be58aa-46fb-1fda-e063-0937940a5162
12. BGS OR/14/029, London Basin LithoFrame model, "Uncertainty". https://earthwise.bgs.ac.uk/index.php/OR/14/029_Uncertainty
13. GSA Annual Meeting 2007 abstract on the LithoFrame viewer (predictive boreholes, synthetic sections). https://gsa.confex.com/gsa/2007AM/webprogram/Paper128361.html
14. BGS OR/15/046, Groundhog Desktop user guide. https://earthwise.bgs.ac.uk/index.php/OR/15/046_Overview
15. Bentley/Seequent, Leapfrog Works. https://www.bentley.com/products/leapfrog-works. Alignment serial sections: https://seequent.com/cross-sections-alignment-serial-sections-2. Crossrail 2 case: https://www.seequent.com/how-leapfrog-works-helped-understand-and-communicate-ground-conditions-for-the-proposed-crossrail-2-railway/
16. Seequent, "What is implicit modelling?" https://help.seequent.com/Works/4.0/en-GB/Content/concepts/implicit-modelling.htm. Cowan et al., "Practical Implicit Geological Modelling", AusIMM 5th Int. Mining Geology Conf., 2003: https://www.ausimm.com/publications/conference-proceedings/fifth-international-mining-geology-conference/practical-implicit-geological-modelling/
17. GeODin Ground docs, "Creating virtual logs: nearest borehole". https://docs.geodin.com/geodin-ground/virtual-logs/creating-virtual-logs/creating-virtual-logs-nearest-borehole
18. LGRB-Nachrichten 2026/01 (LGRBbohrungen application). https://www.live.lgrb-bw.de/sites/default/files/download_pool/lgrbn_2026-01.pdf
19. BGE disclaimer for the Baden-Württemberg part of the GeORG 3D model (LGRB, 2008–2013). https://www.BGE.de/fileadmin/user_upload/Standortsuche/3D-Viewer/Disclaimer_BW_GeORG_nicht_barrierefrei.pdf
20. Journel, A. G. (1983), "Nonparametric estimation of spatial distributions", *Mathematical Geology* 15(3):445–468 (bibliographic reference only). Companion SIS method docs: https://krigekit.readthedocs.io/en/latest/auto_examples/simulation/s_sis_lithofacies.html
21. Carle, S. & Fogg, G. (1996), "Transition probability-based indicator geostatistics", *Mathematical Geology* 28. T-PROGS in GMS: https://aquaveo.com/software/gms-tprogs. Review (*Computers & Geosciences*, 2016): https://iris.unive.it/bitstream/10278/3673854/1/1-s2.0-S0098300416301479-main.pdf
22. Goovaerts, P., on kriging variance as a reliability measure (citing *Geostatistics for Natural Resources Evaluation*, OUP 1997). https://nku.edu/~longa/modules/geostats/lec/krigvariance.html
23. Webster, R. & Oliver, M. A. (1992), "Sample adequately to estimate variograms of soil properties", cited via Kerry & Oliver, World Congress of Soil Science 2006. https://a-c-s.confex.com/crops/wc2006/techprogram/P14837.HTM
24. Phoon, K.-K. & Kulhawy, F. H. (1999), "Characterization of geotechnical variability", *Canadian Geotechnical Journal* 36(4):612–624. https://repository.sutd.edu.sg/esploro/outputs/journalArticle/Characterization-of-geotechnical-variability/9911198209846 (the 40–60× ratio is from a secondary citation).
25. Kitterød, N.-O. (2017), "Estimating unconsolidated sediment cover thickness by using the horizontal distance to a bedrock outcrop as secondary information", *HESS* 21:4195–4211. https://hess.copernicus.org/articles/21/4195/2017/
26. Garzón, S. et al. (Utrecht University / TNO), "Assessing the Geological Plausibility of Machine Learning Borehole Interpretations: Roer Valley Graben", EGU25-10915. https://meetingorganizer.copernicus.org/EGU25/EGU25-10915.html
27. "Use of Tree-Based Machine Learning Methods for Stratigraphic Classification in 3D Geological Modelling" (NTU Singapore). https://nanyangtechnologicaluniv.demo.elsevierpure.com/en/publications/use-of-tree-based-machine-learning-methods-for-stratigraphic-clas. Ensemble virtual boreholes, *Int. J. Digital Earth* (Dec 2024): https://doaj.org/article/e76eade8205c49a7886a6dfd82c4b7cb
28. Oulapour, Adib & Saidian (2018), kriging-variance-based borehole selection with a genetic algorithm. https://ijoce.iust.ac.ir/article-1-324-en.html
29. Turf.js, `interpolate` (IDW). https://turfjs.org/docs/api/interpolate
30. MapTiler, "MapLibre v2: 3D terrain" (pitch up to 85°). https://maptiler.com/news/2022/05/maplibre-2
31. deck.gl, MapLibre integration (interleaved mode). https://deck.gl/docs/api-reference/maplibre/overview
32. CesiumJS, GlobeTranslucency reference. https://cesium.com/learn/cesiumjs/ref-doc/GlobeTranslucency.html. Underground features thread: https://community.cesium.com/t/help-us-test-the-new-underground-features-in-cesiumjs/9581
33. Anthropic, Structured outputs docs. https://platform.claude.com/docs/en/build-with-claude/structured-outputs. OpenAI Structured Outputs (summary): https://simonwillison.net/2024/Aug/6/openai-structured-outputs
34. Li et al., "Can LLM Already Serve as a Database Interface? A BIg Bench for Large-Scale Database Grounded Text-to-SQLs" (BIRD), NeurIPS 2023. https://huggingface.co/papers/2305.03111
35. GPS.gov, GPS accuracy. https://www.gps.gov/systems/gps/performance/accuracy/
36. Google ARCore, Geospatial API quickstart (Android). https://developers.google.com/ar/develop/java/geospatial/quickstart
37. WebXR browser support 2026 (secondary). https://vr.org/articles/webxr-interop-2026-cross-browser-standard
38. Trimble SiteVision. https://geospatial.trimble.com/en/products/software/trimble-sitevision
39. Utrecht University thesis, "Subsoil on a mobile device: visualizing and estimating the distance and depth of underground infrastructure". https://studenttheses.uu.nl/handle/20.500.12932/11621
40. SPT refusal criteria (secondary summaries of ASTM D1586): https://en.wikipedia.org/wiki/Standard_penetration_test and *Fundamentals of Foundation Engineering*, §1.5: https://newcastle.pressbooks.pub/fundamentals-of-foundation-engineering/chapter/1-5-the-standard-penetration-test-spt/
41. ITA-AITES / ITIG, *A Code of Practice for Risk Management of Tunnel Works*, 3rd edition. https://about.ita-aites.org/component/k2/2204/code-of-practice-for-risk-management-in-tunnels-works-3rd-edition
42. Hong Kong CEDD GEO, Technical Guidance Note 25. https://www.cedd.gov.hk/filemanager/eng/content_427/TGN25_2a.pdf
43. "Semi-automated correlation of Silurian well logs across Gotland, Sweden using dynamic time warping with barycenter averaging", *The Sedimentary Record*. https://thesedimentaryrecord.scholasticahq.com/article/147894-semi-automated-correlation-of-silurian-well-logs-across-gotland-sweden-using-dynamic-time-warping-with-barycenter-averaging
44. Kovačević et al., comparison of European soil classification with USCS, *Građevinar*. https://doaj.org/article/6455a0ba473d46d59cd65e01946562d0. ISSMGE ISC5 paper on classification: https://www.issmge.org/uploads/publications/25/26/ISC5_028.pdf
45. U.S. National Committee on Tunneling Technology (1984), *Geotechnical Site Investigations for Underground Projects*, Vol. 1, National Academies Press. https://nap.nationalacademies.org/read/919. The often-quoted borehole-length rule of thumb could not be verified in this session, so it is not used.
46. Montanuniversität Leoben / Herrenknecht, cutting-force measurement system for disc-cutter TBMs. https://pure.unileoben.ac.at/en/publications/entwicklung-eines-schneidkraftmesssystems-f%C3%BCr-diskenbest%C3%BCckte-tun/
47. Herrenknecht patents (C. Himmelsbach), cutting tool with wear sensor. https://patents.justia.com/inventor/christian-himmelsbach
48. Samui & Sitharam (2008), rock depth by ordinary kriging, Bangalore, *Geotech. Geol. Eng.* https://link.springer.com/article/10.1007/s10706-008-9185-4
49. Bentley webinar, "From ground investigation to numerical analysis: connected geotechnical workflows for tunnel design" (OpenGround → Leapfrog Works). https://www.bentley.com/en/webinars/from-ground-investigation-to-numerical-analysis-a-connected-geotechnical-workflows-for-tunnel-design/
