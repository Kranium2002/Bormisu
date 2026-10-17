# Bormisu — Speaker Script (5 min)

## 02 · Hook: more than 3 million hours (~25 s)

*(the number counts up to > 3,000,000 — let it land)*

> More than 3 million hours.
> That's how much time the Gotthard Base Tunnel saves its passengers every year.
> That means goods travel faster.
> That means the cost of living goes down.
> That means parents get more time with their families.

## 03 · Herrenknecht video (~30 s, talk over the footage)

> All of that because of one of Europes greates hidden Champions: Herrenknecht.
> The world's most advanced tunnel boring machine company,
> They build the machines for the Paris Metro, the Grand Paris Express.
> Their machines dug London's Elizabeth line, right under the city.
> In Hong Kong, they built the biggest tunnel boring machine ever — 17.6 metres — for the airport link under the sea.

## 04 · Stuttgart 21 🤫 (~5 s)

>And they also built for Stuttgart 21 but we don't talk about that.

*(let the laugh happen, then move on)*

## 05 · Drilling (~25 s)

> But to build tunnels like these, you have to understand the ground. And that means drilling.
> A drill core tells you what the ground is made of — soil or rock, how hard, where the water sits.
> That decides which machine you build. 
> Get it wrong, and the machine is wrong.

## 06 · Offenburg (~25 s)

> And there are a lot of them. This is how much has been drilled in Offenburg alone.
> This data is all kept on one website. But even here, it doesn’t follow one standard — and pieces are missing.

## 07 · Reports from around the world (~25 s)


> Now think internationally. Herrenknecht works in Hong Kong, skandinavia, South America.
> This is what the reports really look like.
> Handwritten, in Norwegian. A Spanish soil probe sheet. A Korean drill log.
> Every country does it differently  often every company does.
> So we built the thing that standardises all of it.

## 08 · Demo (~2:30)


## 09 · Under the hood (~20 s)

*(six boxes: Upload → Classify → OCR → Extract → Check → Map)*

> Upload. Mistral Large sorts the pages. OCR only where there's borehole data — Mistral OCR from Paris, the best we found.
> Then it pulls out every value with its source box — never a finished number.
> Then plain Python checks it against DIN 4023, and it lands on the map.

## 10 · Sovereignty (~25 s)

*(three cards: Cloud today · One GPU, 32 GB · Mac mini, 32 GB — with the Le Chonk cat as an easter egg)*

> Today it runs in the cloud on Mistral — Mistral Large, also known as Le Chonk.
> But borehole reports are confidential. So the same pipeline runs on open models — PaddleOCR-VL to read, Qwen 3.8 27B for the rest.
> That fits on one 32-gigabyte GPU in your server room. Or on a Mac mini with 32 gigabytes in a site office. Nothing leaves the building.

## 11 · In a nutshell (~15 s)

*(three checkmarks on the left, the tiramisu logo on the right)*

> So, in a nutshell:
> It's multilingual — any language, any format, even handwriting.
> It's a sovereign stack — cloud today, your own server or a Mac mini tomorrow.
> And it's ready to use — now.

## 132 · Questions

> Questions?

---

## Sources

### Slide 02 (more than 3 million hours)

- The tunnel carried on average **16,400 passengers a day** in 2025, and 9,000 a day in 2015 ([swissinfo, SBB figures](https://www.swissinfo.ch/eng/swiss-democracy/the-gotthard-base-tunnel-ten-years-on/91672319)).
- Time saved: about **30 minutes** from the base tunnel alone ([swissinfo](https://www.swissinfo.ch/eng/business/gotthard-base-tunnel_world-s-longest-rail-tunnel-has-a-way-to-go/42940622)), about **1 hour** on Zurich–Milan together with the Ceneri tunnel ([Gulf News](https://gulfnews.com/amp/story/world%2Feurope%2Fthe-worlds-longest-tunnel-opens-in-switzerland-1.1838836)).
- **Per year:** 16,400 × 0.5 h × 365 ≈ **2.99 million hours** with only the base tunnel's 30 minutes. With the full hour saved on Zurich–Milan it is about **6 million**, so "more than 3 million" holds.
- Freight time is not counted.

### Slide 03 (said over the video)

- Gotthard Base Tunnel (hook, slide 02) bored with Herrenknecht machines: [Herrenknecht press release](https://www.herrenknecht.com/en/newsroom/pressreleasedetail/gotthard-base-tunnel-mechanized-tunnelling-completed-on-the-north-side/), [Wikipedia](https://en.wikipedia.org/wiki/Herrenknecht)
- London Crossrail / Elizabeth line, TBMs built by Herrenknecht: [gfxspeak](https://gfxspeak.com/archives/burrowing-machines-crossrail/), [The Construction Index](https://www.theconstructionindex.co.uk/news/view/crossrail-tbm-ellie-breaks-through-in-docklands?amp=1)
- Grand Paris Express, 19 Herrenknecht TBMs: [Tunnelbuilder](https://tunnelbuilder.com/News/Launch-of-the-first-TBM-for-the-Grand-Paris-Express-.aspx)
- Hong Kong Tuen Mun–Chek Lap Kok, 17.6 m Mixshield, largest TBM: [Herrenknecht reference](https://herrenknecht.com/en/references/referencesdetail/hong-kong-tuen-mun-chek-lap-kok-link), [Guinness](https://www.guinnessworldrecords.com/world-records/78259-largest-tunnel-boring-machine)
- Stuttgart 21 Filder Tunnel, Herrenknecht TBM "SUSE": [Herrenknecht press release](https://herrenknecht.com/en/newsroom/pressreleasedetail/suse-sibylle-wanda-and-kaethchen-from-baden-set-a-fast-pace-in-swabia)

### Slides 04–07 (images)

- Stuttgart 21: construction photo of the main station (`img/s21.jpg`, supplied by Mateo).
- Drilling: photo of an auger drilling rig on site (`img/drill-rig.jpg`, supplied by Mateo).
- Offenburg: screenshot of the LGRB borehole map around Offenburg (`img/offenburg-map.jpg`, supplied by Mateo).
- Reports, front: `ToughOne1` p2 (Norway, handwritten), `AF02` p1 (Spanish soil probe sheet), `SEA01` p1 (Korean). Background: 27 more pages from the challenge dataset (`img/bg/`).

### Slide 10 (sovereignty)

The figures are public estimates, not measured on our data.

- Qwen 3.8 27B, 4-bit MLX build ~16–19 GB, tested on a 32 GB Mac mini M4 at ~5–6 tokens/s: [orcarouter](https://www.orcarouter.ai/blog/qwen-3-8-27b-mlx)
- PaddleOCR-VL runs on Apple Silicon via mlx-vlm: [PaddleOCR docs](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html)
- Not yet confirmed: whether Qwen 3.8 27B accepts images, and its licence.
- "Le Chonk" as the nickname for Mistral Large 4: from Mateo, not checked. Cat image supplied by Mateo (`img/chonk-cat.png`).
