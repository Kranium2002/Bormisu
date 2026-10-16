import os
import sys
import json
import base64
import hashlib
from pathlib import Path
from typing import Dict, Any, Optional, List
import httpx
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

class MistralOCRExtractor:
    def __init__(self, openrouter_key: Optional[str] = None, mistral_key: Optional[str] = None):
        self.openrouter_key = openrouter_key or os.getenv("OPENROUTER_API_KEY")
        self.mistral_key = mistral_key or os.getenv("MISTRAL_API_KEY")
        self.dataset_dir = Path(os.getenv("DATASET_PATH", r"C:\Users\aravm\Downloads\HKBoreholeChallenge_Data_BFH2026"))

    def _file_hash(self, file_path: Path) -> str:
        hasher = hashlib.sha256()
        with open(file_path, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        return hasher.hexdigest()[:16]

    def _get_cache_path(self, file_path: Path) -> Path:
        f_hash = self._file_hash(file_path)
        return CACHE_DIR / f"ocr_{file_path.stem}_{f_hash}.json"

    def process_document(self, file_path: str or Path, force_refresh: bool = False, max_pages: int = 5) -> Dict[str, Any]:
        """
        Process a borehole document (PDF or Image) using Mistral OCR (via OpenRouter or direct Mistral).
        Results are cached locally to avoid redundant API costs.
        """
        path = Path(file_path)
        if not path.is_absolute() and self.dataset_dir.exists():
            candidate = self.dataset_dir / "BoreholeData" / path
            if candidate.exists():
                path = candidate
            else:
                # Search recursively inside BoreholeData
                matches = list((self.dataset_dir / "BoreholeData").glob(f"**/{path.name}"))
                if matches:
                    path = matches[0]

        if not path.exists():
            raise FileNotFoundError(f"File not found: {path}")

        cache_file = self._get_cache_path(path)
        if cache_file.exists() and not force_refresh:
            print(f"[CACHE HIT] Loading cached OCR result for {path.name} from {cache_file.name}")
            with open(cache_file, "r", encoding="utf-8") as f:
                return json.load(f)

        print(f"[PROCESSING] Running OCR on: {path.name} ({path.stat().st_size / 1024:.1f} KB)")

        # Strategy 1: OpenRouter with Mistral OCR engine
        if self.openrouter_key and self.openrouter_key.strip():
            result = self._process_via_openrouter(path, max_pages=max_pages)
        # Strategy 2: Direct Mistral API
        elif self.mistral_key and self.mistral_key.strip():
            result = self._process_via_direct_mistral(path)
        else:
            raise ValueError(
                "Neither OPENROUTER_API_KEY nor MISTRAL_API_KEY is configured. "
                "Please add your key in the .env file."
            )

        # Cache result
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"[CACHE SAVED] Result saved to {cache_file.name}")

        return result

    def _process_via_openrouter(self, file_path: Path, max_pages: int = 5) -> Dict[str, Any]:
        """
        Send document to OpenRouter using plugins: [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}]
        with Mistral Large 2411 or Mistral Small to return structured Herrenknecht schema + markdown.
        """
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.openrouter_key}",
            "HTTP-Referer": "https://github.com/Kranium2002/Bormisu",
            "X-Title": "Herrenknecht Borehole Geodatabase",
            "Content-Type": "application/json"
        }

        # Handle PDF/image base64
        ext = file_path.suffix.lower()
        mime = "application/pdf"
        if ext in [".jpg", ".jpeg"]:
            mime = "image/jpeg"
        elif ext == ".png":
            mime = "image/png"

        # If PDF has many pages, we slice the first `max_pages` for efficiency if needed
        pdf_bytes = None
        if ext == ".pdf":
            import fitz
            doc = fitz.open(file_path)
            total_pages = len(doc)
            if total_pages > max_pages:
                print(f"[NOTICE] Document has {total_pages} pages. Processing first {max_pages} pages for fast extraction.")
                sub_doc = fitz.open()
                sub_doc.insert_pdf(doc, from_page=0, to_page=min(max_pages - 1, total_pages - 1))
                pdf_bytes = sub_doc.tobytes()
            else:
                with open(file_path, "rb") as f:
                    pdf_bytes = f.read()
        else:
            with open(file_path, "rb") as f:
                pdf_bytes = f.read()

        b64_data = base64.b64encode(pdf_bytes).decode("utf-8")
        data_uri = f"data:{mime};base64,{b64_data}"

        prompt = (
            "You are an expert geotechnical engineering data extractor for Herrenknecht AG tunnel boring machines.\n"
            "This document is a borehole drilling log or geotechnical report.\n"
            "Using Mistral OCR layout parsing, perform TWO tasks:\n"
            "1. Extract all text and tables in faithful Markdown format, preserving columns for depth, stratigraphy, soil/rock descriptions, and test parameters.\n"
            "2. Standardize all extracted data into Herrenknecht's target schema (aligned with DIN 4023 / BoreholeDataFormat.xlsx).\n\n"
            "Return a strictly valid JSON object with this exact structure:\n"
            "{\n"
            "  \"raw_markdown_ocr\": \"...\",\n"
            "  \"metadata\": {\n"
            "    \"borehole_id\": \"...\",\n"
            "    \"borehole_name\": \"...\",\n"
            "    \"project_name\": \"...\",\n"
            "    \"location_name\": \"...\",\n"
            "    \"country\": \"...\",\n"
            "    \"coordinates\": {\"latitude\": float_or_null, \"longitude\": float_or_null, \"system\": \"...\"},\n"
            "    \"surface_elevation_mASL\": float_or_null,\n"
            "    \"total_depth_m\": float_or_null,\n"
            "    \"drilling_date\": \"...\",\n"
            "    \"notes\": \"...\"\n"
            "  },\n"
            "  \"stratigraphy_layers\": [\n"
            "    {\n"
            "      \"depth_from_m\": float,\n"
            "      \"depth_to_m\": float,\n"
            "      \"soil_rock_name\": \"...\",\n"
            "      \"stratigraphic_unit\": \"...\",\n"
            "      \"uscs_group\": \"...\",\n"
            "      \"din4023_code\": \"...\",\n"
            "      \"color_consistency\": \"...\",\n"
            "      \"rqd_percent\": float_or_null,\n"
            "      \"core_recovery_percent\": float_or_null,\n"
            "      \"spt_blows\": int_or_null,\n"
            "      \"ucs_mpa\": float_or_null,\n"
            "      \"water_table_m\": float_or_null\n"
            "    }\n"
            "  ],\n"
            "  \"test_results\": {\n"
            "    \"max_ucs_mpa\": float_or_null,\n"
            "    \"cai_cerchar\": float_or_null,\n"
            "    \"rmr\": float_or_null,\n"
            "    \"q_system\": float_or_null,\n"
            "    \"cohesion_kpa\": float_or_null,\n"
            "    \"friction_angle_deg\": float_or_null\n"
            "  },\n"
            "  \"confidence_score\": float (0.0 to 1.0)\n"
            "}\n"
            "Only return the raw JSON object. Do not include markdown code block markers like ```json."
        )

        file_block = (
            {"type": "image_url", "image_url": {"url": data_uri}}
            if mime.startswith("image/")
            else {"type": "file", "file": {"filename": file_path.name, "file_data": data_uri}}
        )

        payload = {
            "model": "mistralai/mistral-large-2411",
            "plugins": [
                {
                    "id": "file-parser",
                    "pdf": {
                        "engine": "mistral-ocr"
                    }
                }
            ],
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        file_block
                    ]
                }
            ],
            "temperature": 0.1
        }

        with httpx.Client(timeout=120.0) as client:
            resp = client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                print(f"[ERROR] OpenRouter request failed: {resp.status_code} - {resp.text}")
                # Fallback to pure mistral small if large fails
                payload["model"] = "mistralai/mistral-small-24b-instruct-2501"
                resp = client.post(url, headers=headers, json=payload)
                if resp.status_code != 200:
                    raise RuntimeError(f"OpenRouter OCR call failed: {resp.status_code}: {resp.text}")

            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()
            
            # Clean possible markdown wrap
            if content.startswith("```json"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]
            
            try:
                parsed = json.loads(content.strip())
            except Exception as e:
                # If json parsing had a trailing issue, save raw response
                parsed = {
                    "raw_response": content,
                    "error": f"JSON parsing error: {e}",
                    "file_name": file_path.name
                }
            
            parsed["file_name"] = file_path.name
            parsed["extractor_engine"] = "openrouter/mistral-ocr"
            return parsed

    def _process_via_direct_mistral(self, file_path: Path) -> Dict[str, Any]:
        """
        Process directly using mistralai SDK with mistral-ocr-2503
        """
        from mistralai import Mistral
        client = Mistral(api_key=self.mistral_key)

        print(f"[MISTRAL] Uploading {file_path.name} to Mistral API...")
        with open(file_path, "rb") as f:
            uploaded_file = client.files.upload(
                file={
                    "file_name": file_path.name,
                    "content": f,
                },
                purpose="ocr"
            )

        print(f"[MISTRAL] Calling mistral-ocr-2503 for file_id {uploaded_file.id}...")
        ocr_response = client.ocr.process(
            model="mistral-ocr-2503",
            document={
                "type": "document_url",
                "file_id": uploaded_file.id
            }
        )

        markdown_pages = [page.markdown for page in ocr_response.pages]
        combined_markdown = "\n\n--- Page Break ---\n\n".join(markdown_pages)

        return {
            "file_name": file_path.name,
            "extractor_engine": "mistral-ocr-2503",
            "page_count": len(ocr_response.pages),
            "raw_markdown_ocr": combined_markdown,
            "pages": markdown_pages
        }
