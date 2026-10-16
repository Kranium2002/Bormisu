# 05 · Bid / project manager (sales side)

An engineer who moved into sales and now runs TBM tenders commercially. They are not a geotechnical expert. They want answers, not tables.
They work from a laptop in meeting rooms, sometimes a tablet, and drop any tool that needs more than a few clicks.

## Scenario

- **Project:** "Al Noor Line" (fictional). It is a new metro line in the Gulf region with about 14 km of twin bored tunnel. The client is the "Al Noor Transit Authority" (fictional).
- **Deadline:** the first client meeting starts at 14:00 today. That is **60 minutes from now**.
- **What the client wants to see:**
  1. a world map of where Herrenknecht already has borehole data, to show experience
  2. a one-page geology and risk summary for this line: rock vs soft ground, groundwater, worst ground, data gaps
  3. something they can keep (a PDF or slides)
  4. similar past projects to name in the meeting
- **What's at stake:** the shortlist for 4 TBMs. This first meeting sets the TBM type we propose (EPB, slurry or mixed shield) and the cutterhead story (disc cutters vs scrapers, cutter wear). It also sets how much risk contingency we price in. The client's consultant will test whether we understand their ground. If we look generic, we lose the shortlist.

## Today, without Bormisu

- **Map:** I reuse a marketing slide with hand-placed dots from last year. It is out of date, and nobody knows which dots have real ground data behind them.
- **Geology summary:** I email the geotechnical team. They read the client's site investigation (SI) report, often 100+ scanned pages, and write a ground summary. That takes them 1 to 3 working days.
- **Similar projects:** I rely on memory and message colleagues on Teams: "Didn't we do something in soft coastal ground with high water?"
- **Slides:** I build them myself from the pieces above.

**Time (persona estimate):** the proper version takes 2–3 working days of a geotechnical engineer's time plus about half a day of mine. With only 1 hour I get maybe a third of it: the old map slide, a skim of the client's executive summary, and two project names from memory. I go in mostly with talk.

## Walkthrough

| # | Screen | I do | I expect | What happened / friction | Need (button/feature) |
|---|---|---|---|---|---|
| 1 | World map | Open Bormisu on the laptop. The meeting is in 60 minutes. | A world view of where we have ground data, grouped **by project**. | About 300 dots in clusters, coloured by depth class. Depth colour tells me nothing. Nothing shows how many projects or countries we cover. | **KPI strip** above the map: "N projects · M boreholes · K countries". **"Projects / Boreholes" toggle** top-left of the map, where a project is one pin. |
| 2 | World map | Try to use the map as my "experience" slide. | A clean, branded picture I can drop into slide 3. | The filter panel, results table and popups are in the way. There is no export. The labels show other clients' project names and borehole IDs, and I can't show those to this client. | **"Presentation mode" button** top-right of the map. It hides the controls and anonymises labels ("Metro · Middle East · 2021"). Next to it, an **"Export map (PNG / slide)"** button. |
| 3 | World map | Narrow the map to the Gulf and search "Al Noor". | One project page for this tender. | The filters are project, country, depth and has-rock-data. I tick countries one by one: six clicks, and I'm not sure I got them all. The search returns 23 boreholes. Each one opens a single-borehole page. There is no project page. | **Region chips** at the top of the filter panel (Middle East, Europe, Asia-Pacific …). A **place search** box. Clicking a project pin or name opens a **new Project summary screen** (described below this table). |
| 4 | Upload & processing queue | Drop in the client's new SI volume (fictional "ANL-SI-Vol2", 160 scanned pages, English with Arabic headers) that arrived yesterday. | Progress and an ETA, so I know whether it lands before 14:00. | The status says "classifying pages". There is no ETA, no page count and no notification, so I keep refreshing. | **Per-document progress** on the row ("page 40 of 160 · ~12 min left") and a **"Notify me when ready" bell**. |
| 5 | Upload & processing queue | Wait. The status flips to "needs review · 9 boreholes". | Either someone reviews it, or I can use it as a draft. | It just sits there. I'm not a geotechnical engineer, so I must not approve fields. There is no owner and no way to hand it on. | **"Assign reviewer" button** on the row, with a name picker and a due time. A **"Use as draft" switch** that lets unreviewed data into the summary, with a visible DRAFT watermark. |
| 6 | Extraction review | Open the review screen out of curiosity. | Something I can act on. | The scan is on the left and about 40 fields with confidence badges are on the right, plus Approve / Edit / Flag. Reviewing is not my job, so I close it. **As an editing screen it is useless to me.** | Hide Approve / Edit for a **"Viewer" role**. I only need this screen as read-only evidence (see row 15). |
| 7 | Borehole detail | Open one borehole to get a feel for the ground. | A plain answer: soft ground or rock, and where the water is. | I see a DIN 4023 hatching column and a layer table with SPT "50/30", RQD and TCR. I can't read the hatching, and I don't know whether 50/30 is good or bad. One hole also says nothing about a 14 km line. | A **one-line plain-language summary** above the profile: "Loose sand to 6 m, weak limestone below. Water at 1.8 m." A **ground-class colour strip** (soft / mixed / weak rock / hard rock) next to the DIN column. |
| 8 | Project summary (missing) | Look for the share of rock vs soft ground. | "Along the tunnel: 40 % rock, 45 % soft ground, 15 % mixed face." | No such screen exists. I'd have to export 23 xlsx files and add up layer thicknesses in Excel. That doesn't fit in 50 minutes. | A **Project summary screen** with a **ground-class share bar** at the top. |
| 9 | Project summary | Check which depth the share is computed over. | It uses the tunnel horizon only. | Nothing in the concept knows where the tunnel is. Layers above the crown don't matter to the TBM, so whole-borehole averages would mislead me and the client. | A **"Tunnel horizon" input** at the top of the summary: crown and invert depth, or an **"Upload alignment (KML / DXF)"** button. The share recalculates instantly. |
| 10 | Project summary | Look for groundwater. | The shallowest water level and the max water pressure at the invert, in bar. Those drive EPB vs slurry and the seal spec. | Each borehole has one groundwater number, with no date, no reading count and no chemistry. In coastal Gulf ground, saline and sulphate-rich water affects the segments and the machine. | A **Groundwater card**: shallowest level, max head at invert (bar), number of readings and date range, and "chemistry: not in source" shown as a gap, not a blank. |
| 11 | Project summary | Look for the worst ground. | The top 3 risks in plain words, e.g. cavities, hard abrasive bands, mixed face. | There are no hazard fields. UCS and CAI sit in optional lab tests and are mostly empty. To me, empty and zero look the same. | A **"Worst ground" card**: a ranked list, each risk with the borehole and depth it comes from. **"Not found in source"** in grey italics, never shown as 0. |
| 12 | Project summary | Look for data gaps. | Where we know nothing, so I can price contingency and ask the client for more data. | Nothing tells me. Later the geotechnical team tells me that a 3 km stretch has no boreholes, and that 4 holes have no stated coordinate system, so their pins on the map are guesses. | A **"Data gaps" card**: route sections with no borehole within 250 m, missing test types (e.g. no CAI, no UCS), and boreholes with a guessed coordinate system. A **"Copy as clarification questions"** button. |
| 13 | Project summary | Look for similar past projects. | 3–5 comparable Herrenknecht jobs to name in the meeting. | There is no such feature. The data has no TBM type, diameter, year or outcome, so it couldn't match on what matters anyway. | A **"Similar projects" panel**: match score plus reason ("soft ground over weak rock · water < 3 m · coastal"), the TBM type used, and a **"Can we name it? yes / anonymised / no"** tag. |
| 14 | Project summary | Look for an export for the one-pager. | "Export tender brief (PDF)" and slides. | The only export is xlsx / csv / json, and it's on the borehole detail screen. The client will never open a JSON file. | **"Export tender brief (PDF, 1 page)"** and **"Export slides (.pptx)"** buttons, top-right of the Project summary. Every export gets a footer: data basis, review coverage, date, and DRAFT if unreviewed data was used. |
| 15 | Project summary → Extraction review (read-only) | In the meeting, on the tablet, the client's consultant asks: "Where does 40 % rock come from?" | Tap the number and see the boreholes and the source page. | The concept has no path from a summary number back to its source. I'd have to say "I'll get back to you", which kills credibility. | **Every number on the summary is tappable.** A tap lists the contributing boreholes, then opens the read-only review view with the source highlighted. A **stamp on each card**: "18 of 23 boreholes reviewed by an engineer". |

**The screen I actually need: "Project summary" (tender brief).** It's one page that works on a tablet. From top to bottom:
- **Header:** project name, the client-safe display name, region, and a status chip ("18 / 23 reviewed" or "DRAFT").
- **Tunnel horizon bar:** crown and invert depth, or an uploaded alignment.
- **Four cards:** ground share (soft / mixed / weak rock / hard rock), groundwater, worst ground, data gaps.
- **Geology along the route** (optional): a horizontal strip along chainage, coloured by ground class, with a tick for each borehole.
- **Right column:** similar projects.
- **Top-right buttons:** Presentation mode, Export tender brief (PDF), Export slides (.pptx).

The four planned screens are useful to the engineers who feed this page. For me, only the world map and this new screen matter.

## Top frictions

1. **There is no project-level answer.** Every planned screen works per borehole. I need "how much rock, where's the water, what's missing" for one tunnel, and the concept gives me 23 tables.
2. **The map isn't safe to show a client.** It shows other clients' project names and borehole IDs, and there's no presentation or anonymised mode. Using it as designed in a meeting would leak confidential data.
3. **There is no client-ready output.** The only exports are xlsx / csv / json. There's no PDF one-pager, no slide and no map image, which is exactly what I walk out of the building with.
4. **I can't tell what's reviewed.** I can't see whether a number comes from reviewed data or a raw AI extraction, and I can't tap through to the source page. The queue has no ETA and no reviewer to hand work to.
5. **There are no similar projects, and the data couldn't support them.** The schema has no project-level facts (TBM type, diameter, year, outcome), so a "similar projects" list can't be built properly.

## Wishlist

| Feature | Type | Screen | Priority | Why |
|---|---|---|---|---|
| Project summary (tender brief) screen | screen | Project summary (new) | must | My questions are about one tunnel, not one borehole. |
| Ground-class share bar (soft / mixed / weak rock / hard rock) | feature | Project summary | must | Rock vs soft ground is the first thing the client and TBM type selection need. |
| Tunnel horizon input (crown / invert depth) or "Upload alignment (KML / DXF)" | data field | Project summary | must | Only the ground at the tunnel face matters, not the full borehole. |
| Groundwater card (shallowest level, max head at invert in bar, reading count, dates) | feature | Project summary | must | Water pressure drives EPB vs slurry and the seal design. |
| "Worst ground" card with ranked risks and source borehole and depth | feature | Project summary | must | The client asks "what scares you?" in every first meeting. |
| "Data gaps" card (unsampled route sections, missing tests, guessed coordinate system) | feature | Project summary | must | Gaps decide contingency pricing and the questions we send back to the client. |
| "Export tender brief (PDF, 1 page)" button | button | Project summary | must | This is the thing I hand over or email after the meeting. |
| "Export map (PNG / slide)" button | button | World map | must | The experience slide is the opener of every pitch. |
| "Presentation mode" toggle (hides controls, anonymises other clients' projects) | feature | World map, Project summary | must | I can't show another client's project names or borehole IDs. |
| Review coverage stamp ("18 of 23 reviewed") on every card and export | data field | Project summary, exports | must | I need to know, and say, how solid each number is. |
| Tap any summary number to see its source boreholes and page (read-only review view) | feature | Project summary → Extraction review | must | If I can't back a number in the meeting, I can't use it. |
| "Similar projects" panel (match reason, TBM type used, "Can we name it?" tag) | feature | Project summary | must | Reference projects are my strongest sales argument. |
| KPI strip ("N projects · M boreholes · K countries") and "Projects / Boreholes" toggle | feature | World map | must | At world zoom I sell projects and countries, not dots. |
| "Use as draft" switch with DRAFT watermark | button | Upload queue, Project summary | should | Lets me use fresh data before review without pretending it's checked. |
| "Assign reviewer" button with name picker and due time | button | Upload queue | should | I can't review, so I need to hand it to someone. |
| Per-document progress, ETA and "Notify me when ready" bell | feature | Upload queue | should | Tells me whether the data lands before the meeting. |
| "Export slides (.pptx)" button (map, summary, similar projects) | button | Project summary | should | Saves rebuilding the slides by hand. |
| "Copy as clarification questions" button | button | Project summary (Data gaps card) | should | Turns gaps straight into the tender clarification questions. |
| Region chips and place search | feature | World map | should | Six country clicks to get "the Gulf" is too many. |
| "Colour by" dropdown in the legend (depth / ground class / review status) | button | World map | should | Depth colouring means nothing to me. Ground class does. |
| Plain-language one-line summary above the profile | feature | Borehole detail | should | It lets me read a borehole without knowing the DIN hatching. |
| Tablet layout with large tap targets in presentation mode | feature | World map, Project summary | should | I present from a tablet half the time. |
| "Viewer" role with Approve / Edit hidden | feature | Extraction review | should | Stops sales from approving geotechnical data by accident. |
| Ground-class colour strip next to the DIN 4023 column | feature | Borehole detail | nice | A simpler reading of the same profile. |
| Geology-along-the-route strip (chainage bar coloured by ground class) | feature | Project summary | nice | The clearest single picture of the line for a slide. |
| "Add to tender pack" basket (like LGRB's Merkliste) | feature | World map, Borehole detail | nice | Collects the boreholes and projects I want in one pack. |
| Summary language switch (EN / DE / AR) | feature | Project summary | nice | Some client teams prefer Arabic, and HQ prefers German. |

## Schema gaps

- **Project record:** the target format has only ProjectID and ProjectName. A tender needs tunnel length, tunnel diameter, alignment geometry and the tunnel horizon (crown / invert elevation).
- **Borehole position relative to the tunnel:** chainage and offset from the alignment. Without these I can't say which stretch of the line a borehole describes.
- **Herrenknecht project facts:** TBM type used (EPB / slurry / mixed shield / hard rock), machine reference, year, outcome and lessons learned, and actual cutter consumption. "Similar projects" needs all of these.
- **Confidentiality:** data owner, sharing permission (internal / anonymised / public) and a client-safe display name per project.
- **Country / region:** metadata has only a free-text LocationName. There's no country or region field to filter on.
- **Ground class per layer:** a simple derived class (soft soil / mixed / weak rock / hard rock). The format only has free-text lithology and a DIN pattern.
- **Groundwater detail:** measurement date, number of readings, type (perched / artesian / tidal) and chemistry (chloride, sulphate, pH). The format has a single numeric Groundwaterlevel.
- **Hazard flags:** cavities or karst, gas, boulders, obstructions, contamination.
- **Review status per borehole:** reviewed yes/no, reviewer and review date. The format has no place for these.

## Deal-breaker

The first time I show a client a number that turns out to be an unreviewed AI guess, or a map that exposes another client's project, I stop using Bormisu, and so does my team.

## Pitch quote

(simulated) "I don't read borehole logs. Give me one page that says how much of the line is rock, where the water is and what we still don't know, with a source behind every number, and I'll open every tender meeting with it."

## With Bormisu

**Time (persona estimate):** about 15–20 minutes, if the project's reports are already in and reviewed:
- about 2 min to export the map in presentation mode
- about 5 min to set the tunnel horizon and read the summary
- about 5 min to pick similar projects
- about 2 min to export the PDF

If a new report has to go through the queue first, add 15–30 minutes of processing. In that case the brief goes out marked DRAFT until an engineer reviews it. That still beats walking in with an old slide and no numbers.
