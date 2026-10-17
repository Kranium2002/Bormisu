# Bormisu — Speaker Script (5 min)

Open `index.html` in Chrome. Arrow keys to advance.

## 01 · Title (~15 s)

> Hi, we're **Team Tiramisu**, and this is **Bormisu**.
> Every borehole report, on one verified map.

## 02 · Today (~40 s)

> Herrenknecht needs to know the ground before it picks a machine.
> That knowledge exists — in borehole reports. Scanned, handwritten, Word, Excel.
> Every report has its own language, its own units, its own coordinate system.
> Today someone types each layer into the Herrenknecht format by hand. And afterwards, nobody can say where a number came from.
> One misread layer can mean the wrong machine underground.

## 03 · Live demo (~2:00)

> Let me show you.

*(switch to the app)*

1. Upload a prepared report (pre-processed, so we don't wait on extraction).
2. The boreholes appear on the map, coloured by review status.
3. Open one: the profile drawn to DIN 4023 — layers, groundwater, samples.
4. Click a value → the scan opens with the exact box. Correct one value live.
5. Confirm the coordinate system → pins turn from amber to normal.
6. Export → the Herrenknecht standard xlsx, approved values only.

*(back to the deck)*

**Backup:** if the network or the app fails, play the recorded run (TODO: record `demo.mp4`).

## 04 · Trust (~20 s)

> Every value carries one of four marks. Sure, unsure, flagged, or not in the source.
> We never invent a value and never guess a position. If we don't know, the field is empty — with the reason.

## 05 · Under the hood (~30 s)

> Models read, Python decides.
> A small model sorts the pages, OCR runs only where there is borehole data, and the extractor returns raw text with its source box — never a finished number.
> Units, SPT, coordinates and DIN codes are normalised in plain Python, and every doubt becomes a question for a person.

## 06 · Models (~30 s)

> Today this runs on cloud models — and providers that store or train on prompts are excluded.
> But borehole reports are confidential, so here's what local looks like.
> Every step has an open-weight replacement: PaddleOCR-VL for OCR, Qwen3-VL to sort pages, gpt-oss for extraction and chat.
> One server with two GPUs. The LLM steps already speak the OpenAI API, so it's a config change; OCR needs one adapter. The reports never leave the building.

## 07 · Next (~20 s)

> Next: draw your tunnel and get a section from real boreholes only, with the gaps marked.
> Click a point and see the nearest evidence — and if there is none within 200 metres, it says so.

## 08 · Team (~15 s)

> That's us — Team Tiramisu, built in Breisgau.

## 09 · Close (~10 s)

> Every value has a source. Thank you — questions?

---

## Sources for slide 06 (example local stack)

The figures are public estimates, not measured on our data. Check the model cards before sizing hardware.

- PaddleOCR-VL ~0.9B, Apache 2.0, a few GB VRAM: [Spheron](https://www.spheron.network/blog/best-open-source-ocr-vlm-self-host-gpu-cloud-2026/), [docsumo](https://www.docsumo.com/blog/best-ocr-models)
- Qwen3-VL-30B-A3B, MoE 30B / 3B active, ~17 GB at 4-bit (AWQ): [vLLM recipe](https://recipes.vllm.ai/Qwen/Qwen3-VL-30B-A3B-Instruct), [AWQ quant page](https://dev.co/ai/llms/qwen3-vl-30b-a3b-thinking-awq)
- gpt-oss-120b on one 80 GB GPU, gpt-oss-20b in 16 GB, Apache 2.0, structured outputs and tool calling: [morphllm](https://www.morphllm.com/gpt-oss), [LM Studio](https://lmstudio.ai/models/gpt-oss)
- Why not Mistral Large locally: 675B MoE, needs a full 8-GPU node: [Mistral 3](https://mistral.ai/news/mistral-3), [premai](https://blog.premai.io/how-to-self-host-mistral-large-3-hardware-vllm-setup-function-calling-2026)
- Why not Mistral Small 4 locally: 119B MoE, ~242 GB weights: [Simon Willison](https://feeds.simonwillison.net/tags/mistral/)
- Qwen3-Embedding-8B ~16 GB is our estimate (8B parameters at bf16), not a published figure.
