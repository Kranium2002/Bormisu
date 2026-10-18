# Bormisu: Speaker Script (5 min)

## 01 · Title
> This glas of dirt and stones is the key to building tunnels.
> Its a soil sample.
## 02 · Profile

> Its just a chunk of soil that you take out of the earths crust.
> and that is what it looks like on a plan.
> It tells you exactly what the ground is made of: which material sits at which layer.
> You can see where the ground water is.
> And you can see where the samples are taken and with which yo determine the  exact specifications of the material.

## 03 · Offenburg

> But you don't drill just ones. In Offenburg alone, there are about 2.000 documented soil samples.
> This data is all kept on one database.
> However here starts the problem, even this one database doesn't follow one standard, and pieces are missing.

## 04 · World

> For Herrenknecht, the problem becomes way bigger because they not only work in offenburg they work in the whole Worl.
> They build the machines for the Paris Metro. 
> The airport link in Hong Kong and in South America, the new metro line in Lima.

## 05 · Stuttgart 21 🤫

> They also built the machine for Stuttgart 21. But we don't talk about that.

## 06 · Reports from around the world

> When you work internationally, the data looks really messi.
> This is what real reports look like.
> A Spanish soil probe sheet. 
> Handwritten, in Norwegian. 
> A Korean drill log.
> Every country does it differently. 
> Often every company does.
> So we built the thing that standardises all of it.

## 07 · Demo

> Docuemnt upload
> Line drawing
> Chat feature
> show sources review thing
## 08 · Key features

**Click 1:**
> It reads any report: scans, handwriting, any language. And where it's unsure, it flags the case for a human to verify.

**Click 2:**
> Area scraping: draw an area or a planned line, and you get an overview of many soil samples at once.

**Click 3:**
> And export: your data in your format, as PDF, JPEG or CSV.

## 09 · Sovereignty

> Today it runs in the Mistral cloud where you can run it under zero data retention.
> If you want to keep the data completely private you can run a similar pipeline on open models, which run either on a premise server or your own PC.

## 10 · In a nutshell

> In a nutshell:
> It's multilingual: any language, any format, even handwriting works.
> It's a sovereign stack: mistral cloud today, your own server or a Mac mini tomorrow.
> And it's ready to use. Now.

## 11 · Questions

> Questions?

---

## Sources

1 hours x 300 x 10 Projects x 60 = month

### Slide 04 (world map, said over it)

- Map data: `data/herrenknecht-projects.json`: 84 documented projects in 40 countries, 426 machines, each with a source URL. A selection, not the full list: Herrenknecht itself speaks of more than 4,100 reference projects in more than 92 countries ([All Around #10](https://allaround.herrenknecht.com/en/issue-10.html)). Rebuild the map data with `python3 data/build_projects.py`.

- Gotthard Base Tunnel bored with Herrenknecht machines: [Herrenknecht press release](https://www.herrenknecht.com/en/newsroom/pressreleasedetail/gotthard-base-tunnel-mechanized-tunnelling-completed-on-the-north-side/), [Wikipedia](https://en.wikipedia.org/wiki/Herrenknecht)
- London Crossrail / Elizabeth line, TBMs built by Herrenknecht: [gfxspeak](https://gfxspeak.com/archives/burrowing-machines-crossrail/), [The Construction Index](https://www.theconstructionindex.co.uk/news/view/crossrail-tbm-ellie-breaks-through-in-docklands?amp=1)
- Grand Paris Express, 19 Herrenknecht TBMs: [Tunnelbuilder](https://tunnelbuilder.com/News/Launch-of-the-first-TBM-for-the-Grand-Paris-Express-.aspx)
- Lima Metro Line 2 (Peru), two TBMs built by Herrenknecht: [Tunnelbuilder](https://tunnelbuilder.com/News/Assembly-started-of-TBM-for-metro-Line-2-in-Peru-.aspx), [Webuild](https://www.webuildvalue.com/en/stories-behind-projects/delia-arrives-at-the-e17-station-on-limas-new-subway-line.html)
- Hong Kong Tuen Mun–Chek Lap Kok, 17.6 m Mixshield, largest TBM: [Herrenknecht reference](https://herrenknecht.com/en/references/referencesdetail/hong-kong-tuen-mun-chek-lap-kok-link), [Guinness](https://www.guinnessworldrecords.com/world-records/78259-largest-tunnel-boring-machine)
- Stuttgart 21 Filder Tunnel, Herrenknecht TBM "SUSE": [Herrenknecht press release](https://herrenknecht.com/en/newsroom/pressreleasedetail/suse-sibylle-wanda-and-kaethchen-from-baden-set-a-fast-pace-in-swabia)

### Images

- Stuttgart 21: construction photo of the main station (`img/s21.jpg`, supplied by Mateo).
- Profile: DIN 4023 profile of borehole BK-01 (fictional sample data, fully logged) from the Bormisu detail screen (`img/profile.png`).
- Offenburg: browser screenshot of the LGRB borehole map at bohrungen.lgrb-bw.de around Offenburg (`img/offenburg-lgrb.png`, supplied by Mateo). The bubbles on the screenshot add up to about 2,680 boreholes (115 clusters = 2,668, plus 13 single points); a few clusters cut off at the edges are not fully counted.
- Reports, front: `ToughOne1` p2 (Norway, handwritten), `AF02` p1 (Spanish soil probe sheet), `SEA01` p1 (Korean). Background: 27 more pages from the challenge dataset (`img/bg/`).

### Slide 09 (sovereignty)

The figures are public estimates, not measured on our data.

- Qwen 3.8 27B, 4-bit MLX build ~16–19 GB, tested on a 32 GB Mac mini M4 at ~5–6 tokens/s: [orcarouter](https://www.orcarouter.ai/blog/qwen-3-8-27b-mlx)
- PaddleOCR-VL runs on Apple Silicon via mlx-vlm: [PaddleOCR docs](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html)
- Not yet confirmed: whether Qwen 3.8 27B accepts images, and its licence.
- "Le Chonk" as the nickname for Mistral Large 4: from Mateo, not checked. Cat image supplied by Mateo (`img/chonk-cat.png`).
