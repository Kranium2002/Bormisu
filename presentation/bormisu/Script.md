# Bormisu — Speaker Script (5 min)

The slides carry almost no text. Everything is said here.
Open `index.html` in Chrome, arrow keys to advance.
Put the Herrenknecht footage next to it as `herrenknecht.mp4`; slide 03 plays it automatically.

## 01 · Title (~10 s)

> Hi, we're **Team Tiramisu**, and this is **Bormisu**.

## 02 · Hook: 4 lifetimes (~25 s)

*(the number counts up, let it land)*

> 4 lifetimes.
> That's how much time the Gotthard Base Tunnel saves its passengers every year.
> That means goods travel faster.
> That means the cost of living goes down.
> That means parents get more time with their families.

## 03 · Herrenknecht video (~30 s, talk over the footage)

> All of that because of one company: Herrenknecht.
> The world's most advanced tunnel boring machine company — from Schwanau, just down the road.
> They build the machines for the Paris Metro, the Grand Paris Express.
> They bored the Gotthard Base Tunnel — 57 kilometres through the Alps.
> In Hong Kong, they built the biggest tunnel boring machine ever — 17.6 metres — for the airport link under the sea.
> And they also built for Stuttgart 21…

## 04 · Stuttgart 21 🤫 (~5 s)

> …but we don't talk about that.

*(let the laugh happen, then move on)*

## 05 · Drill core (~25 s)

> But to build tunnels like these, you have to understand the ground. And that means drilling.
> A drill core tells you what the ground is made of — soil or rock, how hard, where the water sits.
> That decides which machine you build. Get it wrong, and the machine is wrong.

## 06 · Baden-Württemberg (~25 s)

> And there are a lot of them. This is Baden-Württemberg alone — every bubble is thousands of boreholes.
> This data is well kept and classified. But not even here is it all in the same standard.
> Even here, someone has to pull the data out and standardise it by hand.

## 07 · Reports from around the world (~25 s)

> Now think internationally. Herrenknecht works in China, the Middle East, South America.
> This is what the reports really look like:
> Korean drill logs. Handwritten sheets from Norway and Malaysia. Spanish, Catalan. Typewriter scans.
> Every country does it differently — often every company does.
> So we built the thing that standardises all of it.

## 08 · Demo (~1:30)

> Let me show you.

*(switch to the app)*

1. Upload a prepared report (pre-processed, so we don't wait on extraction).
2. The boreholes appear on the map, coloured by review status.
3. Open one: the profile drawn to DIN 4023 — layers, groundwater, samples.
4. Click a value → the scan opens with the exact box. Correct one value live.
5. Export → the Herrenknecht standard xlsx, approved values only.

*(back to the deck)*

**Backup:** if the network or the app fails, play the recorded run (TODO: record `demo.mp4`).

## 09 · Under the hood (~20 s)

> Upload. A small model sorts the pages. OCR only where there's borehole data — Mistral OCR from Paris, the best we found.
> A large model pulls out every value with its source box — never a finished number.
> Then plain Python checks it against DIN 4023, and it lands on the map.

## 10 · Sovereignty (~25 s)

> Today it runs in the cloud on Mistral.
> But borehole reports are confidential. So the same pipeline runs on open models — PaddleOCR-VL to read, Qwen 3.8 27B for the rest.
> That fits on one 32-gigabyte GPU in your server room. Or on a Mac mini with 32 gigabytes in a site office. Nothing leaves the building.

## 11 · Team — skipped for now

> That's us — Team Tiramisu, built in Breisgau.

## 12 · In a nutshell (~15 s)

> So, in a nutshell:
> It's multilingual — any language, any format, even handwriting.
> It's a sovereign stack — cloud today, your own server or a Mac mini tomorrow.
> And it's ready to use — now.

## 13 · Questions

> Questions?
> *(beat)* Questions about Stuttgart 21 go to Deutsche Bahn.

---

## Sources

### Slide 02 (4 lifetimes)

Rough calculation, assuming a lifetime of about 80 years (700,000 hours):

- The tunnel carried on average **16,400 passengers a day** in 2025, and 9,000 a day in 2015 ([swissinfo, SBB figures](https://www.swissinfo.ch/eng/swiss-democracy/the-gotthard-base-tunnel-ten-years-on/91672319)).
- Time saved: about **30 minutes** from the base tunnel alone ([swissinfo](https://www.swissinfo.ch/eng/business/gotthard-base-tunnel_world-s-longest-rail-tunnel-has-a-way-to-go/42940622)), about **1 hour** on Zurich–Milan together with the Ceneri tunnel ([Gulf News](https://gulfnews.com/amp/story/world%2Feurope%2Fthe-worlds-longest-tunnel-opens-in-switzerland-1.1838836)).
- **Per year:** 16,400 × 0.5 h × 365 ≈ 3.0 million hours ≈ **4 lifetimes**. With a full hour saved: ≈ 9 lifetimes.
- **Since it opened (2016–2026):** about 13,000 passengers a day on average × 0.5 h × 365 × 10 years ≈ 24 million hours ≈ **34 lifetimes**. With a full hour saved: ≈ 68 lifetimes.

The slide uses the conservative per-year figure: **4 lifetimes** (30 minutes saved, 2025 ridership). Freight time is not counted.

### Slide 03 (said over the video)

- Gotthard Base Tunnel bored with Herrenknecht machines: [Herrenknecht press release](https://www.herrenknecht.com/en/newsroom/pressreleasedetail/gotthard-base-tunnel-mechanized-tunnelling-completed-on-the-north-side/), [Wikipedia](https://en.wikipedia.org/wiki/Herrenknecht)
- Grand Paris Express, 19 Herrenknecht TBMs: [Tunnelbuilder](https://tunnelbuilder.com/News/Launch-of-the-first-TBM-for-the-Grand-Paris-Express-.aspx)
- Hong Kong Tuen Mun–Chek Lap Kok, 17.6 m Mixshield, largest TBM: [Herrenknecht reference](https://herrenknecht.com/en/references/referencesdetail/hong-kong-tuen-mun-chek-lap-kok-link), [Guinness](https://www.guinnessworldrecords.com/world-records/78259-largest-tunnel-boring-machine)
- Stuttgart 21 Filder Tunnel, Herrenknecht TBM "SUSE": [Herrenknecht press release](https://herrenknecht.com/en/newsroom/pressreleasedetail/suse-sibylle-wanda-and-kaethchen-from-baden-set-a-fast-pace-in-swabia)

### Slides 05–07 (images)

- Drilling: photo of an auger drilling rig on site (`img/drill-rig.jpg`, supplied by Mateo).
- Baden-Württemberg: screenshot of the LGRB borehole map (`img/bw-map.png`).
- Reports: `SEA01` p1 (Korean), `ToughOne1` p2 (Norway, handwritten), `ToughOne2` p1 (Malaysia, handwritten), `AF02` p1 (Spanish), `profile01.jpg` (Catalan), `MEA01` p3 (typewriter), `SEA02` p1, `MEA03/BH-1.jpg` (Kuwait), `SAM01` p1.

### Slide 10 (sovereignty)

The figures are public estimates, not measured on our data.

- Qwen 3.8 27B, 4-bit MLX build ~16–19 GB, tested on a 32 GB Mac mini M4 at ~5–6 tokens/s: [orcarouter](https://www.orcarouter.ai/blog/qwen-3-8-27b-mlx)
- PaddleOCR-VL runs on Apple Silicon via mlx-vlm: [PaddleOCR docs](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html)
- Not yet confirmed: whether Qwen 3.8 27B accepts images, and its licence.
