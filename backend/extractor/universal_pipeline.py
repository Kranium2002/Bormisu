import os
import sys
import json
import base64
import hashlib
from pathlib import Path
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv
from mistralai import Mistral

load_dotenv()

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HERRENKNECHT_SYSTEM_PROMPT = """You are a senior geotechnical engineering AI specialist for Herrenknecht AG (the global leader in Tunnel Boring Machines - TBMs).
Your task is to take extracted document text & tables (from borehole logs, drilling reports, core photos, or survey sheets in ANY language: Norwegian, German, Portuguese, English, Spanish, French, etc.) and convert them into the official Herrenknecht Borehole Data Standard.

OUTPUT REQUIREMENT:
You MUST ALWAYS return a SINGLE strictly valid JSON object matching the schema below.
NEVER return markdown fences like ```json. ONLY return the raw JSON object.

HERRENKNECHT JSON SCHEMA:
{
  "document_info": {
    "file_name": string,
    "source_language": string,
    "confidence_score": float (0.0 to 1.0),
    "total_boreholes_found": integer
  },
  "boreholes": [
    {
      "metadata": {
        "borehole_id": string (e.g. "BH-502", "BH-1", "S-1"),
        "borehole_name": string,
        "location_name": string or null,
        "country": string or null,
        "project_id": string or null,
        "project_name": string or null,
        "client": string or null,
        "drilling_contractor": string or null,
        "driller_name": string or null,
        "drilling_date": string or null,
        "surface_elevation_mASL": float or null,
        "coordinates": {
          "latitude": float or null (WGS84 decimal degrees),
          "longitude": float or null (WGS84 decimal degrees),
          "local_x": float or null,
          "local_y": float or null,
          "coordinate_system": string (e.g. "WGS84", "UTM", "Local Oslo")
        },
        "borehole_depth_m": float,
        "casing_info": string or null,
        "notes": string or null
      },
      "stratigraphy": [
        {
          "depth_from_m": float,
          "depth_to_m": float,
          "thickness_m": float,
          "original_description": string (original language description),
          "english_lithology": string,
          "din4023_code": string (ONE OF: "Topsoil", "Fill", "Clay", "Silt", "Sand", "Gravel", "Clay/Till", "Sandstone", "Limestone", "Granite", "Gneiss", "Chalk", "Peat"),
          "uscs_group": string (e.g. "CL", "CH", "ML", "MH", "SP", "SW", "GP", "GW", "GM", "ROCK", "FILL"),
          "consistency_density": string or null,
          "rqd_pct": float or null,
          "core_recovery_pct": float or null,
          "spt_n_value": integer or null,
          "water_table_m": float or null,
          "ucs_mpa": float or null
        }
      ],
      "geotechnical_tests": {
        "water_content_pct": float or null,
        "density_kn_m3": float or null,
        "max_ucs_mpa": float or null,
        "cai_cerchar_abrasivity": float or null,
        "rqd_pct": float or null,
        "friction_angle_deg": float or null,
        "cohesion_kpa": float or null,
        "water_table_m": float or null
      },
      "tbm_engineering_assessment": {
        "cutter_abrasivity_risk": string ("Low" | "Moderate" | "High" | "Extreme"),
        "face_stability_risk": string ("Stable" | "Overbreak Risk" | "Chimney Collapse Hazard"),
        "water_ingress_risk": string ("Dry / Minor" | "Moderate Inflow" | "High Permeability / Severe Ingress Risk"),
        "recommended_tbm_mode": string ("Earth Pressure Balance (EPB)" | "Slurry TBM (Mixshield)" | "Open Gripper / Hard Rock Shield")
      }
    }
  ]
}

CRITICAL RULES:
1. ALWAYS read every layer interval (from - to) meticulously.
2. If the document describes multiple boreholes (e.g. summary table or multiple forms), include EACH borehole as an item in the "boreholes" array.
3. If an individual borehole has handwritten stratum logs, extract the EXACT layer boundaries and descriptions.
4. Translate any foreign geological term accurately into the standard DIN 4023 classification and USCS group.
5. All numeric values must be numbers (float/int), not strings with units.
6. Return JSON only."""

class UniversalBoreholePipeline:
    """
    Universal ingestion and standardization pipeline supporting ALL file types
    (PDF, Images, DOCX, CSV/XLSX) in ANY language, always outputting standard Herrenknecht JSON.
    """
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("MISTRAL_API_KEY")
        if not self.api_key:
            raise ValueError("MISTRAL_API_KEY is not configured in .env")
        self.client = Mistral(api_key=self.api_key)
        self.dataset_dir = Path(os.getenv("DATASET_PATH", r"C:\Users\aravm\Downloads\HKBoreholeChallenge_Data_BFH2026"))

    def resolve_file(self, file_path: str or Path) -> Path:
        path = Path(file_path)
        if path.is_absolute() and path.exists():
            return path
        
        # Check relative to workspace
        if path.exists():
            return path.resolve()
            
        # Check in dataset dir
        if self.dataset_dir.exists():
            candidate = self.dataset_dir / "BoreholeData" / path
            if candidate.exists():
                return candidate
            # Search recursively in BoreholeData
            matches = list((self.dataset_dir / "BoreholeData").glob(f"**/{path.name}"))
            if matches:
                return matches[0]
                
        raise FileNotFoundError(f"Cannot resolve borehole document: {file_path}")

    def _file_hash(self, path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        return h.hexdigest()[:16]

    def extract_document(self, file_input: str or Path, force_refresh: bool = False, max_pages: int = 15) -> Dict[str, Any]:
        """
        Universal extraction function:
        1. Ingests any document format (PDF, DOCX, JPG, PNG).
        2. Performs Mistral OCR 2503 layout parsing.
        3. Uses Mistral Structured AI to map into official Herrenknecht Borehole JSON.
        4. ALWAYS returns strictly valid JSON.
        """
        file_path = self.resolve_file(file_input)
        f_hash = self._file_hash(file_path)
        cache_file = CACHE_DIR / f"universal_{file_path.stem}_{f_hash}.json"

        if cache_file.exists() and not force_refresh:
            print(f"[CACHE HIT] Loading standardized JSON for {file_path.name}")
            with open(cache_file, "r", encoding="utf-8") as f:
                return json.load(f)

        print(f"[PROCESSING] Ingesting {file_path.name} ({file_path.stat().st_size / 1024:.1f} KB)...")

        # Step 1: Universal OCR / Text Extraction
        raw_markdown = self._extract_to_markdown(file_path, max_pages=max_pages)

        # Step 2: Universal Standardization to Herrenknecht JSON Schema
        print(f"[STANDARDIZING] Transforming extracted layout to Herrenknecht Borehole JSON...")
        standardized_json = self._standardize_to_herrenknecht_json(file_path.name, raw_markdown)

        # Cache valid JSON output
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(standardized_json, f, indent=2, ensure_ascii=False)

        print(f"[SUCCESS] Standardized JSON cached to: {cache_file.name}")
        return standardized_json

    def _extract_to_markdown(self, file_path: Path, max_pages: int = 15) -> str:
        ext = file_path.suffix.lower()

        # Handle DOCX documents universally
        if ext in [".docx", ".doc"]:
            print(f"[UNIVERSAL] Reading Word document structure...")
            import docx
            doc = docx.Document(file_path)
            parts = []
            for p in doc.paragraphs:
                if p.text.strip():
                    parts.append(p.text.strip())
            for t_idx, table in enumerate(doc.tables):
                parts.append(f"\n### Table {t_idx + 1}\n")
                for r in table.rows:
                    row_cells = [cell.text.replace("\n", " ").strip() for cell in r.cells]
                    parts.append("| " + " | ".join(row_cells) + " |")
            return "\n\n".join(parts)

        # Handle Images (JPG, PNG) directly via Mistral OCR
        if ext in [".jpg", ".jpeg", ".png"]:
            print(f"[MISTRAL OCR 2503] Processing image...")
            mime = "image/jpeg" if ext in [".jpg", ".jpeg"] else "image/png"
            with open(file_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
            
            ocr_resp = self.client.ocr.process(
                model="mistral-ocr-2503",
                document={
                    "type": "image_url",
                    "image_url": f"data:{mime};base64,{b64}"
                }
            )
            return "\n\n".join([page.markdown for page in ocr_resp.pages])

        # Handle PDFs (Multi-page or single) via Mistral OCR 2503
        if ext == ".pdf":
            print(f"[MISTRAL OCR 2503] Uploading and scanning PDF...")
            import fitz
            doc_len = len(fitz.open(file_path))
            pages_to_scan = list(range(min(max_pages, doc_len)))
            
            with open(file_path, "rb") as f:
                uploaded_file = self.client.files.upload(
                    file={"file_name": file_path.name, "content": f},
                    purpose="ocr"
                )

            signed_url = self.client.files.get_signed_url(file_id=uploaded_file.id).url
            
            ocr_resp = self.client.ocr.process(
                model="mistral-ocr-2503",
                document={
                    "type": "document_url",
                    "document_url": signed_url
                },
                pages=pages_to_scan
            )
            return "\n\n--- Page Break ---\n\n".join([page.markdown for page in ocr_resp.pages])

        raise ValueError(f"Unsupported file format: {ext}")

    def _standardize_to_herrenknecht_json(self, filename: str, markdown_content: str) -> Dict[str, Any]:
        """
        Uses Mistral AI with strict JSON mode to parse and standardize
        all extracted tables, layers, and parameters into Herrenknecht schema.
        """
        # Truncate content to avoid token overflow if huge, keeping core tables
        text_payload = markdown_content
        if len(text_payload) > 80000:
            text_payload = text_payload[:80000] + "\n\n[TRUNCATED]"

        user_prompt = f"""Document Filename: {filename}

Extracted Document Content (Markdown & Tables from Mistral OCR):
--------------------------------------------------
{text_payload}
--------------------------------------------------

Standardize all boreholes, layers, and parameters from this content into the official Herrenknecht Borehole JSON format.
Always return valid JSON only."""

        chat_resp = self.client.chat.complete(
            model="mistral-small-latest",
            response_format={"type": "json_object"},
            temperature=0.1,
            messages=[
                {"role": "system", "content": HERRENKNECHT_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt}
            ]
        )

        content = chat_resp.choices[0].message.content.strip()
        try:
            parsed_json = json.loads(content)
        except json.JSONDecodeError as e:
            # Fallback if wrapped
            if content.startswith("```"):
                content = content.split("```")[1]
                if content.startswith("json"):
                    content = content[4:]
            parsed_json = json.loads(content.strip())

        return parsed_json
