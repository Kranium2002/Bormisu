# Challenge brief: Herrenknecht Borehole Challenge (BFH 2026)

Challenge page: https://hackathon.badencampus.de/en/hackathons/0a0bf3ab-5468-482d-823c-78c1f68e6e74 (the full brief requires a participant login).

## Official challenge

**Title:** *Automated extraction and standardisation of drilling data for a global geodatabase*

**Summary:** Herrenknecht needs reliable subsurface information to design tunnel boring machines. Borehole data from tunnel and mining projects worldwide arrives in mixed formats, languages and representations, and is currently analysed by hand. The task:
- **Extract and standardise** this data automatically.
- Store it in a **georeferenced, searchable central database**.
- Make it accessible through an **interactive world map**.

## Event facts

| | |
|---|---|
| Event | Black Forest Hackathon 2026, track "Smart Automation" (BadenCampus) |
| Where / when | flow1986, Offenburg. Fri 16 Oct 15:00 – Sun 18 Oct 16:00, 2026 |
| **Submission deadline** | **Sun 18 Oct, 11:30**: public GitHub repo link via the platform, **plus a PPT** |
| Pitches | From Sun 13:00, **5 minutes per team** |

### Judging

**Code: 50%.** An AI agent builds the project and scores code and architecture. **Build failures cost points.** The repo must build cleanly from a fresh clone, with a clear README and run instructions.

**Pitch: 50%**, split as:

| Criterion | Weight |
|---|---|
| Problem understanding | 25% |
| Solution & demo | 35% |
| Business value | 20% |
| Presentation quality | 20% |

### Hard rules for this repo

- **No challenge data, sensitive or personal data in GitHub.** Only code and documentation go here. No sample reports, scans, PDFs or fixtures from the dataset.
- **No API keys in GitHub.** OpenRouter keys get auto-revoked if pushed. Use `.env`, which is gitignored.

## What the input looks like (summary)

- **Mixed formats:** real geotechnical reports from tunnel and mining projects on 6 continents. Native-text PDFs (text layers often scrambled or broken), scanned PDFs, Word files with embedded scans, photos/images, some handwriting, some pages rotated.
- **Many languages:** about 7, European and Asian.
- **Metric units throughout,** but depth below ground and elevation are mixed across many local datums, coordinates come in about 10 different systems (sometimes unstated), and decimal commas are common.
- **Inconsistent notation:** SPT is written about 10 different ways (e.g. `3,6,7 = 13`, `2/3/4/4/5/6 N=19`, `50/30`, `N=R`, …). Rock-quality data (TCR / RQD) appears as numbers, bars or plots.
- **Varying structure:** one page per borehole in some reports, multi-sheet logs in others, and logs buried in 100+ page reports.

## What we're given

- A **target schema**: see [target-format.md](target-format.md).
- The **DIN 4023** drawing standard: see [din4023-cheatsheet.md](din4023-cheatsheet.md).
- A **UI reference**, the LGRB borehole portal: see [reference-site.md](reference-site.md).

## Our solution scope

1. **Ingest** any report (PDF / scan / docx / image).
2. **Extract** borehole metadata, the layer log and test values into the target format (OCR + LLM + layout).
3. **Normalise** units, coordinates (→ WGS84 for the map), and soil names → DIN codes.
4. **Review and correct** with a human in the loop: the source page next to the extracted fields, with confidence scores.
5. **Visualise** with a world map of boreholes, plus a DIN 4023 profile column and layer table per borehole.
6. **Export** to the standard format (xlsx / csv / json).

**Business value:** this cuts the time from report to usable geology model from days to minutes. It also makes data from different projects comparable, which matters for TBM selection, cutter-wear prediction (CAI/UCS) and risk assessment.

## Open questions for the Herrenknecht mentors

1. Is the xlsx the required output format, or is any format with those fields OK?
2. Must the profile be drawn strictly per DIN 4023, or is "LGRB-like" enough?
3. Which documents will they demo or test on? Are there hidden test files?
4. Are LLM/OCR APIs OK on the confidential data? (OpenRouter keys are provided, so probably yes.)
