# Personas

Five simulated Herrenknecht users we used to stress-test the Bormisu concept before building it. Each one walked through the 4 planned screens (world map, borehole detail, extraction review, upload & queue). Their walkthroughs are in [walkthroughs/](walkthroughs/).

These personas are **simulated**: AI agents role-playing realistic jobs at a TBM manufacturer, not interviews with real people. All project names, IDs and values are fictional.

**Results:**
- [feature-backlog.md](feature-backlog.md): every button and feature the personas asked for, deduplicated and ranked, per screen.
- [build-cut.md](build-cut.md): what we build by Sun 11:30, what we cut, the 5-minute demo storyline and pitch lines.
- [features-explained.md](features-explained.md): every feature in plain words (what you see, why, how), with a glossary.

| # | Persona | Job to be done | Key screens |
|---|---|---|---|
| 01 | [Geotechnical engineer, tender phase](walkthroughs/01-geotech-engineer.md) (core user) | Turn a messy 150-page report into the standard xlsx before a Monday tender | Upload → review → detail → export |
| 02 | [TBM / cutterhead design engineer](walkthroughs/02-tbm-design-engineer.md) | Get UCS / CAI / RQD at tunnel depth to estimate cutter wear | Map filters → detail → compare → export |
| 03 | [Senior engineering geologist](walkthroughs/03-senior-geologist.md) (skeptic) | Trace every number to its source and sign off with liability | Review → detail → audit trail |
| 04 | [Data reviewer / working student](walkthroughs/04-data-reviewer.md) | Clear 30+ low-confidence scanned logs by 17:00 | Queue → review |
| 05 | [Bid / project manager](walkthroughs/05-bid-manager.md) | Show experience and a one-page geology risk summary in a client meeting | Map → summary → share |

## 01 · Geotechnical engineer, tender phase (core user)

Civil/geotechnical engineer with about 6 years in the Geotechnics & Tender team. Today they re-type layer logs from client PDFs into Excel, sketch a longitudinal section, and brief the TBM design team. Excel power user, two monitors.

**Scenario:** Friday 15:00. A ~150-page report for the fictional "Project Nordlys Metro" arrives: half text, half scanned, two languages, local grid with no stated CRS, logs spread over several sheets. The tender is due Monday.

## 02 · TBM / cutterhead design engineer

Mechanical engineer who picks the machine type (EPB / slurry / hard-rock) and lays out the disc cutters. Needs hard numbers at tunnel depth: UCS, CAI, RQD, groundwater, fines content. Exports to their own Excel/Python wear models.

**Scenario:** cutterhead design for the fictional 6 km "Project Alpenquell" water tunnel, crown 25–40 m below ground. The cutter-consumption estimate is due Wednesday. Only a few boreholes have lab tests.

## 03 · Senior engineering geologist (skeptic and approver)

25 years of experience and gives the final geotechnical sign-off before data goes into a binding tender. One wrong number can become a contract claim. Distrusts AI extraction by default. Annotates PDFs by hand.

**Scenario:** spot-checks a colleague's extraction of the fictional "Project Harbour Crossing": SPT refusal values, the guessed CRS, a suspicious layer boundary and the groundwater level. Needs to see who changed what, approve the set, and defend it later.

## 04 · Data reviewer / working student (bulk QA)

Geoscience master's student, 20 h/week, measured on review throughput. Knows the basics, fast on the keyboard, dislikes mouse-heavy UIs.

**Scenario:** ~30 scanned Portuguese-language SPT logs with decimal commas, plus a handwritten, partly rotated PDF mixing three form types. The queue must be clear by 17:00.

## 05 · Bid / project manager (sales side)

Engineer turned bid manager. Needs answers, not tables. Uses a laptop or tablet in meeting rooms.

**Scenario:** the client meeting for the fictional Gulf-region "Project Al Noor Line" starts in 1 hour. They want a world map of existing borehole data, a one-page geology and risk summary, something to drop into slides, and similar past projects to mention.
