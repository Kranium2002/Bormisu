# Bormisu — Speaker Script (5 min)

Open `index.html` in Chrome. Arrow keys to advance.
Put the Herrenknecht footage next to it as `herrenknecht.mp4`; slide 03 plays it automatically.

## 01 · Title (~10 s)

> Hi, we're **Team Tiramisu**, and this is **Bormisu**.

## 02 · Hook (~15 s)

*TODO: to be defined.*

## 03 · Herrenknecht film (~20 s, speak over the video)

> This is Herrenknecht. Tunnel boring machines from Schwanau, just down the road from us.
> They dig under cities, through mountains and under the sea.

## 04 · Projects (~25 s)

> The Gotthard Base Tunnel — 57 kilometres, the longest railway tunnel in the world.
> Grand Paris Express — 19 Herrenknecht machines building Paris's new metro.
> And in Hong Kong, the biggest tunnel boring machine ever built: 17.6 metres.
> *(beat)* And Stuttgart 21… we don't talk about Stuttgart 21.

## 05 · Ground (~20 s)

> But before the first metre, every tunnel starts with a borehole.
> Layers, strength, water — that's what decides which machine you build.
> Thousands of data points per project. Get them wrong, and the machine is wrong.

## 06 · Formats (~25 s)

> The problem: every country logs it differently. Often every company does.
> Here: a Spanish log from Africa, Australia, South America, Southeast Asia — and handwritten sheets from Norway and Malaysia.
> Different standards, different units, different coordinate systems. We turn all of it into one.

## 07 · Live demo (~1:45)

> Let me show you.

*(switch to the app)*

1. Upload a prepared report (pre-processed, so we don't wait on extraction).
2. The boreholes appear on the map, coloured by review status.
3. Open one: the profile drawn to DIN 4023 — layers, groundwater, samples.
4. Click a value → the scan opens with the exact box. Correct one value live.
5. Export → the Herrenknecht standard xlsx, approved values only.

*(back to the deck)*

**Backup:** if the network or the app fails, play the recorded run (TODO: record `demo.mp4`).

## 08 · Under the hood (~25 s)

> Models read, Python decides.
> A small model sorts the pages, OCR runs only where there is borehole data, and the extractor returns raw text with its source box — never a finished number.
> Units, SPT, coordinates and DIN codes are normalised in plain Python, and every doubt becomes a question for a person.

## 09 · Deployment (~25 s)

> Today it runs in the cloud on Mistral from Paris — the best OCR quality we found.
> But borehole reports are confidential. So the same pipeline runs on open models: PaddleOCR-VL for reading, Qwen 3.8 27B for the rest.
> That fits on one 32-gigabyte GPU in your server room — or even on a Mac mini with 32 gigabytes in a site office. Slower, but nothing leaves the building.

## 10 · Team (~10 s)

> That's us — Team Tiramisu, built in Breisgau.

## 11 · Close (~10 s)

> Questions? We'll dig into them.
> *(beat)* Questions about Stuttgart 21 go to Deutsche Bahn.

---

## Sources

### Slide 04 (projects)

- Gotthard Base Tunnel bored with Herrenknecht machines: [Herrenknecht press release](https://www.herrenknecht.com/en/newsroom/pressreleasedetail/gotthard-base-tunnel-mechanized-tunnelling-completed-on-the-north-side/), [Wikipedia](https://en.wikipedia.org/wiki/Herrenknecht)
- Grand Paris Express, 19 Herrenknecht TBMs: [Tunnelbuilder](https://tunnelbuilder.com/News/Launch-of-the-first-TBM-for-the-Grand-Paris-Express-.aspx)
- Hong Kong Tuen Mun–Chek Lap Kok, 17.6 m Mixshield, largest TBM: [Herrenknecht reference](https://herrenknecht.com/en/references/referencesdetail/hong-kong-tuen-mun-chek-lap-kok-link), [Guinness](https://www.guinnessworldrecords.com/world-records/78259-largest-tunnel-boring-machine)
- Stuttgart 21 Filder Tunnel, Herrenknecht TBM "SUSE": [Herrenknecht press release](https://herrenknecht.com/en/newsroom/pressreleasedetail/suse-sibylle-wanda-and-kaethchen-from-baden-set-a-fast-pace-in-swabia)
- Green `#7DB713`: the main colour in herrenknecht.com's stylesheet

### Slide 06 (formats)

Pages from the challenge dataset (`data/raw_data/BoreholeData`): AF02 p1, AUS01 p1, SAM01 p1, SEA02 p1, ToughOne1 p2, ToughOne2 p1.

### Slide 09 (deployment)

The figures are public estimates, not measured on our data.

- Qwen 3.8 27B, 4-bit MLX build ~16–19 GB, tested on a 32 GB Mac mini M4 at ~5–6 tokens/s: [orcarouter](https://www.orcarouter.ai/blog/qwen-3-8-27b-mlx)
- PaddleOCR-VL runs on Apple Silicon via mlx-vlm: [PaddleOCR docs](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL-Apple-Silicon.html); ~0.9B parameters, a few GB: [Spheron](https://www.spheron.network/blog/best-open-source-ocr-vlm-self-host-gpu-cloud-2026/)
- Not yet confirmed: whether Qwen 3.8 27B accepts images (needed if it classifies pages from the image rather than the OCR text), and its licence.
