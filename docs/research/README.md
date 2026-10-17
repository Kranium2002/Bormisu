# Research log

**Check this index before researching an idea.** If the idea (or a close variant) is listed, read the linked section first. Only re-research when the listed verdict no longer holds, e.g. because new data reaches the frontend. Add a dated note in that case instead of starting over.

## How to add research

1. Search this index (Ctrl+F) for the idea and its synonyms.
2. If it's new, write a report `YYYY-MM-DD-<topic>.md` in this folder, using the template at the bottom.
3. Add one row per idea to the index below: ID, idea, verdict, one-line reason, link, status.
4. Keep verdicts to one of: **Build now · Build lite · Roadmap · Drop**.

## Index

**Decisions in one page:** [extra-features.md](extra-features.md) has what we build, what waits and what we dropped (R1–R14), with reasons and build order.

Reports in this folder:

| Report | Date | Scope |
|---|---|---|
| [2026-10-17-map-feature-research.md](2026-10-17-map-feature-research.md) | 2026-10-17 | 13 map/subsurface feature ideas: value, theory fit, feasibility, trust risk, demo value. 49 sources |

### Ideas researched

| ID | Idea | Verdict | Why, in one line | Effort | Details | Status |
|---|---|---|---|---|---|---|
| R1 | Depth slider (horizontal slice) | **Build lite**: "Colour by: ground in tunnel band", elevation-based | A depth below ground is not a horizon, and "not reached" is not soil. Classify each borehole against a tunnel band instead | 3–5 h after R13 | [§ Feature 1](2026-10-17-map-feature-research.md#feature-1-depth-slider-horizontal-slice) | Not started |
| R2 | 3D borehole sticks | Roadmap | No persona asked for 3D. Leaflet can't do it, and a second map engine plus WebGL in CI is a risk | 12–20 h | [§ Feature 2](2026-10-17-map-feature-research.md#feature-2-3d-borehole-sticks) | Roadmap |
| R3 | Drill-down flythrough | Drop | Eye candy with no work step behind it | 8–12 h | [§ Feature 3](2026-10-17-map-feature-research.md#feature-3-drill-down-flythrough) | Dropped |
| R4 | Draw your tunnel → longitudinal section | **Build lite**: boreholes only, no interpolated lines, per-hole flags, gap bar | Highest value: the DAUB TBM-selection workflow starts from this section, and 4 of 5 personas asked for it | 6–8 h after R13 | [§ Feature 4](2026-10-17-map-feature-research.md#feature-4-draw-your-tunnel--longitudinal-section) | Not started |
| R5 | TBM simulator / cutter-wear meter | Drop | Wear models (CSM, NTNU, Gehring) need CAI, UCS and CLI, which we don't extract. False precision on the most sensitive number | – | [§ Feature 5](2026-10-17-map-feature-research.md#feature-5-tbm-simulator-lite-cutter-wear-meter) | Dropped |
| R6 | Ground-risk heatmap | Drop | Interpolates sparse, mixed-standard data, and a shaded pixel has no source page | – | [§ Feature 6](2026-10-17-map-feature-research.md#feature-6-ground-risk-heatmap) | Dropped |
| R7 | Similar-ground finder | Roadmap | Needs project outcome fields (TBM type, cutter consumption). Weak across classification standards | 5–8 h | [§ Feature 7](2026-10-17-map-feature-research.md#feature-7-similar-ground-finder) | Roadmap |
| R8 | Scan peek on hover | **Build now** | Puts "every number has a source" on the map, with no theory risk | 2–4 h | [§ Feature 8](2026-10-17-map-feature-research.md#feature-8-scan-peek-on-hover) | Not started |
| R9 | Ask the map (LLM → filters) | Roadmap | Schema-constrained output is valid, not necessarily correct, and it's a live API risk. Filter chips do the same job | 6–10 h | [§ Feature 9](2026-10-17-map-feature-research.md#feature-9-ask-the-map-natural-language--filters) | Roadmap |
| R10 | Data-gap map / "drill here next" | **Build lite** inside R4; drop "drill here" | Distance-to-evidence is honest. Proposing drill sites is site-investigation planning | +2–3 h on R4 | [§ Feature 10](2026-10-17-map-feature-research.md#feature-10-data-gap-map-and-drill-here-next) | Not started |
| R11 | One-click tender brief PDF | Roadmap (print view of R4 if time) | High value for the bid persona, but the full version needs a project summary and tunnel horizon | 2–4 h lite, 12–16 h full | [§ Feature 11](2026-10-17-map-feature-research.md#feature-11-one-click-tender-brief-pdf) | Roadmap |
| R12 | AR on a phone | Drop. Replaced by R14 | Phone GPS error is about 5 m, ARCore needs ≤ 10 m and ≤ 15° heading, and iOS has no WebXR AR | 15–30 h | [§ Feature 12](2026-10-17-map-feature-research.md#feature-12-ar-on-a-phone) | Dropped |
| R14 | "My location" on site: the engineer taps a button, the map jumps to them, and the nearest boreholes are listed with distance and direction | **Build now** (user's redirect of R12, 2026-10-17) | Finding the nearest borehole needs metres, not AR-grade anchoring, so ±5 m phone GPS [35 in the map report] is enough. No interpolation: it lists real boreholes by distance. Constraints: the Geolocation API only works in secure contexts (HTTPS or localhost) ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)); laptops locate by Wi-Fi, so tens to hundreds of metres; show the accuracy circle; the position never leaves the browser; the layout's 1280 px min-width needs a responsive pass for phones; sample mode gets a "simulated location" for demos | 3–4 h | This row | In progress (with the World/Country dropdown) |
| R13 | Predict the subsurface at a clicked point ("virtual borehole") | **Build lite**: "nearest evidence here". Show the k nearest real boreholes and their spread, refuse beyond 200 m or outside the investigated area, never show one predicted profile | Can't be defended across projects. Inside a project, 4–14 holes are far below the roughly 100+ points needed to estimate a variogram | 6–9 h | [§ Feature 13](2026-10-17-map-feature-research.md#feature-13-predict-the-subsurface-at-any-clicked-location-virtual-borehole) | Not started |

### Standing conclusions (apply to future ideas too)

- **No interpolated ground between boreholes anywhere in the UI.** That is the geotechnical report's interpretation, not ours ([§13.3–13.4](2026-10-17-map-feature-research.md#133-when-it-makes-sense-and-when-it-does-not)).
- **Elevation, not depth below ground**, whenever boreholes are compared, and only on one stated datum.
- **Never mix projects** in any spatial estimate.
- **Prerequisite for R1, R4 and R13:** a spatially coherent fictional demo project in `frontend/src/sample/`. The current sample boreholes are generated independently.
- **No lab values (UCS, CAI, fines, permeability) reach the frontend yet.** That rules out wear, TBM-type advice and parameter maps until lab tables are extracted.
- **Pitch claims to avoid:** see [§4 of the map report](2026-10-17-map-feature-research.md#4-things-we-should-not-claim-in-the-pitch).

## Related decision records outside this folder

- Persona study, feature backlog and build cut: `docs/personas/` (branch `prada/design`, PR #1). Simulated personas, not interviews.
- UI ↔ API contract: `docs/design/api-contract.md` (same branch).

## Template for a new report

```markdown
# <Topic>

Date: YYYY-MM-DD. Question: <the exact question asked>. Requested by: <who>.

## 1. Summary
| ID | Idea | Verdict | Value | Theory fit | Feasibility | Confidence |

## 2. Methodology
Sources read, lenses applied, what was paywalled or unverified.

## 3. Findings per idea
What users need (with sources) · where the theory breaks · lite version · feasibility · trust risk · demo value · verdict.

## 4. Claims to avoid

## 5. Sources (numbered, with URLs)
```
