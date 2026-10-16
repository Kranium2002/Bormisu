# Build cut: what to build by Sun 11:30

## Verdict

1. Build one thin flow that works from start to finish: drop a messy scanned log, get fields with a source box behind every value, review them, see a DIN 4023 profile, export the target-format xlsx. A thin world map is the way in.
2. Sell trust, not magic. The wow is "click any number, see the exact spot on the original scan". Anything that needs a tunnel alignment, a project model or user accounts is roadmap.
3. For the code judge, ship a tested pipeline package, generated fictional fixtures, and a fresh clone that runs with one command and no API key. Feature freeze is Sun 00:00 (Saturday midnight).

## Build by Sun 11:30

Ranked by what to protect. If time runs short, cut from the bottom. Effort is in developer-hours.

| # | Feature | Screen | Effort | Earns points for | Persona(s) |
|---|---|---|---|---|---|
| 1 | **Skeleton and one-command run.** The API serves the built web app on one port. `make setup && make run`. With no API key, the app starts in demo mode with a fictional sample loaded. CI runs setup, tests and build on a clean runner. | Infra | M · 3 h | Code (fresh-clone build) | none (code judge) |
| 2 | **Shared data model and fictional fixtures.** Typed models for the three target-format parts. Every value carries its raw text, normalised value, unit, page, box, method (Read / OCR / Derived / Guessed / Edited), review status and field state (not in source / illegible). Groundwater is a list of readings. SPT keeps its raw string. Lithology keeps the printed text, a translation and a DIN code. | Cross-cutting | S · 2 h | Code; Problem understanding | All 5 |
| 3 | **Extraction pipeline.** PDF or image → page images → page type (log / lab table / text / drawing / photo) → vision-LLM extraction per log page into the model → box locator (text layer first, then OCR words, else page level with a "box not found" note). The same code runs from a CLI: `bormisu extract report.pdf`. | Backend | L · 8 h | Solution & demo; Code | All 5 |
| 4 | **Normalisers (pure functions, table-driven tests).** An SPT parser for "4,5,5 = 10", "5/2/1/2/3 N=8", "50/30" and "N=R". It returns increments, N, a refusal flag, penetration and unit, and a sum check. The normalisers also detect decimal comma vs dot per document, convert ft → m, and turn coordinates into WGS84 with a CRS status of stated or inferred. | Backend | M · 3 h | Problem understanding; Code | Geotech, Geologist, Reviewer |
| 5 | **Source viewer and "Show source" on every value.** One shared component: page image, highlighted box, method badge. It opens from review fields, profile layers, the layer table and groundwater readings. | Cross-cutting | M · 3 h | Solution & demo (the wow) | All 5 |
| 6 | **Extraction review.** Scan on the left, fields on the right. Raw value next to the normalised one. Lithology as printed / translation / DIN code. An "R" badge on SPT refusals. A method badge instead of a %. Approve, edit and flag, plus "Approve all clean" (Read-type values, no flags). Keys for "not in source" and "illegible". An edit keeps the AI value visible. | Extraction review | M · 5 h | Solution & demo | Geotech, Geologist, Reviewer |
| 7 | **Borehole detail.** DIN 4023 profile column: colours, codes, simple hatching for the main soil and rock types, depths on the left, one ▽ per groundwater reading. A layer table synced with the profile. A metadata card with the rock head, derived from the first rock layer and linked to its source. | Borehole detail | M · 5 h | Solution & demo; Problem understanding | All 5 |
| 8 | **Project export.** The target-format xlsx, with its three parts (metadata, log, tests) laid out as in the organisers' template, plus a provenance sheet. A tidy CSV with one row per value. An "open questions" CSV for the client: flags, illegible values, inferred CRS, missing borehole IDs. Approved-only by default. "Include unreviewed" stamps DRAFT. | Cross-cutting | M · 3 h | Business value; Problem understanding | Geotech, TBM, Geologist, Bid |
| 9 | **Upload & queue with page map.** Drop zone, status steps, found counts (boreholes, layers, SPT, groundwater readings). A page strip coloured by page type, where each unused page shows a reason. Read-only. | Upload & queue | M · 3 h | Solution & demo | Geotech, TBM, Geologist, Reviewer |
| 10 | **World map, thin.** Pins coloured by review status (green / grey / amber). Pins with an inferred CRS are amber. Holes without usable coordinates are listed, not plotted. Search by project or borehole ID. A popup opens Borehole detail. | World map | S · 2 h | Solution & demo (the brief asks for it) | Bid, Geotech |
| 11 | **Checks.** Completeness: borehole IDs named in the report vs IDs extracted. Lint: gaps, overlaps, log bottom vs final depth, SPT or groundwater below final depth, UCS / CAI / RQD out of range. Results appear on the queue row and as flags in review. | Upload & queue, Extraction review | M · 3 h | Problem understanding; Code | Geotech, TBM, Geologist, Reviewer |
| 12 | **Stretch: confirm the CRS once per document.** Show 2–3 candidate CRSs with a pin preview on a mini-map. Confirming stores a name, and the pins turn green. Drop this first. | Extraction review | S · 2 h | Solution & demo | Geotech, Geologist, Reviewer |

**Does it fit?**

- **Planned:** 40 dev-h for items 1–11, plus 2 h of stretch.
- **Capacity, planned for the smallest team (4):** one person owns the pitch, PPT, demo script, README and fresh-clone testing full time. Three coders get ~18 focused hours each before feature freeze, about 54 dev-h.
- **Buffer:** ~14 h (~25%). Integration and LLM prompt tuning always overrun, and the buffer is for that. With 5–7 people, the extra people go to tests, demo caching and the PPT, not to new features.
- **Lanes:**
  - Pipeline: #2, #3, #4 (13 h).
  - Web UI: #5, #6, #7 (13 h).
  - Platform: #1, #8, #9, #10, #11 (14 h).
  - Whoever is ahead takes #12. The UI lane builds against the fictional fixtures from #2, so it never waits for the pipeline.
- **Checkpoints:**
  - Fri 23:00: stack fixed, #1 and #2 merged, CI green.
  - Sat 12:00: walking skeleton. A fictional PDF goes through the pipeline into the review screen and out as xlsx.
  - Sat 16:00: go / no-go. If behind, drop #12, then cut #11 to lint only.
  - Sun 00:00: feature freeze. Process and cache the demo documents.
  - Sun 08:30: fresh-clone run on a second machine, by someone who didn't write the code. README done. Record the fallback video.
  - Sun 10:30: submit the repo link and the PPT. That leaves an hour of slack before 11:30.

## Cut for now

Marked **roadmap** = name it on the roadmap slide.

- **Tunnel alignment upload, chainage and corridor filter:** it needs a project model, a file parser and geometry before anything shows. **roadmap**
- **Longitudinal section along the alignment:** large, and it depends on the alignment. It's the strongest picture for TBM engineers, so it leads the roadmap slide. **roadmap**
- **Lab tables covering many boreholes (UCS / CAI linked by sample ID), Lab tests tab:** this is its own extraction problem. Test values printed on the log page itself are still extracted. **roadmap**
- **Ground parameters summary (n, P10–P90 per rock unit), tunnel horizon band and filter:** these need lab linking and the alignment first. **roadmap**
- **Per-value audit trail, "Approve & lock revision", revisions diff, evidence pack:** these need user accounts. Keeping the AI value next to every edit is enough for the demo. **roadmap**
- **Project summary / tender brief with PDF and slide export:** large, and it needs ground class, tunnel horizon and hazard fields. **roadmap**
- **Similar reference projects:** the data has no TBM type, diameter or outcome to match on. **roadmap**
- **Keyboard-first bulk review:** real value for QA staff, but invisible in a 5-minute demo. **roadmap**
- **Georeferencing from control points, site-plan overlay:** large. An inferred CRS shows as amber instead.
- **Vertical datum offset to MSL:** we store the datum as stated and label elevations "datum unconfirmed". No conversion.
- **Sheet-stitching chip, "Merge with…", "Split here":** the pipeline groups sheets by borehole ID, and the lint flags "log bottom ≠ final depth".
- **Page-type override and re-extracting chosen pages:** the page map stays read-only.
- **Investigation type per location, separate probe table:** the classifier labels the form type. Probe tables come later.
- **Project header panel, per-document number-format control:** the normaliser detects the decimal style, and the raw value stays visible.
- **Confidence reason line, "read from column X" label:** the method badge covers the demo.
- **Move boundary with reason, find similar misreads, spot-check mode, review filters:** power-review tools with no demo value yet.
- **Source viewer pop-out, rotate, magnify:** zoom is enough.
- **Bulk approve by threshold, approve layer or page:** "Approve all clean" covers it.
- **Assign, hand off, notify, "My approvals" inbox, Viewer role:** this build has no user accounts.
- **Processing ETA, "Notify me", hints box at upload:** the status steps are enough.
- **Map extras:** colour-by, KPI strip, projects / boreholes toggle, region chips, parameter chips, column picker, batch filters, "Other projects" layer, tender basket. The map stays thin and is coloured by review status.
- **Presentation mode and anonymisation:** the demo holds no other client's data.
- **Borehole detail extras:** hazard tags, weathering / fracture / SCR fields, depth-elevation toggle, core-runs tab, parameter track, plain-language summary, ground-class strip.
- **Review summary screen, batch grid:** the open-questions CSV covers the hand-off.
- **Picture exports (map PNG, section PDF, pptx):** screenshots do the job for the PPT.
- **Tablet layout, read-only API, language switch, groundwater chemistry:** no demo or judge value this weekend.

## Demo storyline (5 min)

**Persona:** 01, the tender-phase geotechnical engineer (core user). Their story is the challenge statement: a messy report on Friday, a tender on Monday. Borrow one trust line from the senior geologist if there's time.

**The wow moment:** in the clean DIN 4023 profile, click the amber "R" marker of an SPT refusal. The original scanned page opens beside it with the handwritten or printed "50/30" cell boxed. Say: "Every number has a page behind it."

**The document:** a short (2–3 page) scanned borehole log with these traits:

- in Spanish or Norwegian
- decimal commas
- SPT in "4,5,5 = 10" notation, plus one "50/30" refusal
- a groundwater strike and a rest level
- a log that runs over two sheets
- coordinates with no stated CRS

Keep it short so live extraction ends in ~60–90 s. Use a challenge document of this kind only on the demo laptop, never in the repo or the PPT. On Saturday, confirm with the mentors that sending its pages to the LLM API during the pitch is fine. If they say no, demo the fictional sample. PPT screenshots always use the fictional sample, because the PPT gets uploaded.

| Time | Screen | What we show and say |
|---|---|---|
| 0:00–0:40 | Slide | Persona 01's Friday 15:00: a 150-page report, half scanned, two languages, no CRS, tender due Monday 12:00. Today that's ~3 working days of retyping (simulated estimate). These numbers set the TBM type and the cutter-consumption line in the price. At 0:00 a teammate drops the demo log into Upload, so extraction runs while we talk. |
| 0:40–1:15 | Upload & queue | Page map: log pages coloured, a photo page grey with "unused: photo". Found counts. Check chips: report IDs vs extracted IDs, lint results. Say: "It tells you what it read and what it skipped." |
| 1:15–2:15 | Extraction review | Scan on the left, fields on the right. "212,4" → 212.4, with the raw value kept. Lithology as printed → English → DIN code. "50/30" → refusal "R", not N = 50: "that's a boulder or the rock head, not dense sand." Badges say Read / OCR / Guessed, not a made-up %. Click "Approve all clean", then fix one value. The AI value stays visible. |
| 2:15–3:00 | Borehole detail | DIN 4023 profile, one ▽ per groundwater reading, the rock head if the log reaches rock. **Wow:** click the R marker and the scan opens with the cell boxed. |
| 3:00–3:40 | World map → export | The pin is amber: CRS inferred, not stated. (Stretch: confirm it once and the pin turns green.) Export the project: target-format xlsx, provenance sheet, open-questions list for the client. Show the xlsx for 3 seconds. |
| 3:40–4:30 | Slide | Business value: days of retyping become hours of review (simulated target). One comparable database across projects feeds TBM selection and cutter-wear estimates. Roadmap: alignment and longitudinal section, lab-table linking for UCS / CAI, audit trail and sign-off. |
| 4:30–5:00 | Slide | Persona quote. "Builds from a fresh clone, runs without a key, tested pipeline." Repo link. |

**What can break live, and the fallback:**

| Risk | Fallback |
|---|---|
| The LLM API is slow or rate-limited, or the venue Wi-Fi drops | Click "Load cached result": the same document, processed Sat night, loads in a second. Say so out loud. The cache lives outside the repo. |
| The box lands off target on the scan | Rehearse on this exact document and pick the click target in advance. The cached result has a box someone has checked. |
| Map tiles don't load | Open the map once before the pitch so the browser caches the tiles. Review, detail and export don't need tiles. |
| The projector squeezes the split view | Test at 1280×720 and 1920×1080. Set browser zoom beforehand. |
| The laptop or the app crashes | Keep a second laptop running on the cached result. Last resort: a 90-second screen recording of the whole flow, made Sunday morning. |
| The API key is revoked or out of credit | Check Sunday morning. Demo mode needs no key. |

## Pitch lines

Put this footnote on the slide: *"Simulated persona study: 5 AI role-played users, not interviews. Times are their estimates."*

1. **Problem (simulated persona, estimate):** a tender-phase geotechnical engineer estimated ~23–25 hours to turn one 150-page report into the standard sheet. That is their whole weekend before a Monday tender.
2. **Quote (simulated geotechnical engineer):** "I don't need it to be perfect. I need it to show me the page behind every number and the pages it couldn't read, so I can sign off the ground model before the weekend instead of during it."
3. **Time saved (simulated persona, estimate):** the same engineer put the target at ~6 hours hands-on instead of ~3 working days, but only if the tool shows the source and what it skipped. So we built those first. Say "target", not "achieved": we haven't measured it.

## Architecture notes for the code judge

1. **The pipeline is a package, not app code.** `bormisu.pipeline` exposes one entry point, `extract(path) -> ExtractionResult`, and runs the stages ingest → classify → extract → locate → normalise → check. Each stage is a typed function. The API and the CLI both call it. The LLM sits behind an `Extractor` interface with two implementations: `OpenRouterExtractor` and `ReplayExtractor`, which reads a saved JSON. Tests and demo mode use the replay one, so they run offline with the same result every time. Normalisers and checks get table-driven tests, for example one row per SPT notation.
2. **Fixtures are fictional and generated, never copied.** `.gitignore` already ignores `*.pdf`, `*.db` and `*.sqlite`. So `scripts/make_fixtures.py` draws a fictional 2-page log at test time, and its expected JSON is committed next to it. The log has a fictional project and IDs, "4,5,5 = 10" and "50/30", decimal commas, one rotated page and no stated CRS. Don't commit the organisers' xlsx template either: the exporter writes the headers from code, based on `docs/design/target-format.md`. Cached results of challenge documents count as challenge data, so they live outside the repo at a path set in `.env`. Add a CI check that fails if a PDF, XLSX or scan image is committed outside `docs/`.
3. **A fresh clone runs with one command and no key.** `make setup && make run` uses uv and npm, with committed lockfiles. The API serves the built frontend, so there is one process, one port and no CORS. Without `OPENROUTER_API_KEY`, the app starts in demo mode with the fictional sample and shows a banner saying live extraction needs a key. `.env.example` lists every variable. The SQLite file is created on first run (it's gitignored) and seeded from committed fictional JSON. Keep system packages off the default path: render pages with a pip-only library and use a pip-installable OCR engine, so setup has no apt or Tesseract step. CI runs the same commands on a clean runner and also builds a Dockerfile as the second path.
4. **Provenance lives in the data model, and the export is a projection of it.** Every value is `{raw, value, unit, page, box, method, status, state}`. The target-format xlsx is generated from that model: its three parts keep the specified columns, and provenance goes on an extra sheet. "Show source", approved-only export and "blank is not 0" then work the same way on every screen, with no per-screen logic.
5. **Write the README for a judge in a hurry.** At the top: a CI badge, what the app does in 3 lines, and a screenshot of the fictional sample. Then:
   - quick start in 3 commands
   - demo mode vs live mode
   - a diagram of the pipeline stages
   - how to run the tests
   - the data rule: no challenge data in the repo, and set `BORMISU_DATA_DIR` to use a local folder
   - known limits and the roadmap
