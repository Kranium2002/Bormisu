import os
import sys
import io
import json
import base64
import hashlib
from pathlib import Path
from typing import Dict, Any, List, Optional, Union
from dotenv import load_dotenv
from mistralai import Mistral
from PIL import Image

load_dotenv()

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HERRENKNECHT_SYSTEM_PROMPT = """You are a senior geotechnical engineering AI specialist for Herrenknecht AG (the global leader in Tunnel Boring Machines - TBMs).
Your task is to take extracted document text & tables (from borehole logs, drilling reports, core photos, spreadsheets, or survey sheets in ANY language: Norwegian, German, Portuguese, English, Spanish, French, Arabic, Chinese, etc.) and convert them into the official Herrenknecht Borehole Data Standard.

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
          "latitude": float or null (WGS84 decimal degrees if identifiable),
          "longitude": float or null (WGS84 decimal degrees if identifiable),
          "local_x": float or null (Easting / local survey coordinate),
          "local_y": float or null (Northing / local survey coordinate),
          "coordinate_system": string or null (e.g. "WGS84", "UTM", "Local Grid")
        },
        "borehole_depth_m": float or null,
        "casing_info": string or null,
        "notes": string or null
      },
      "stratigraphy": [
        {
          "depth_from_m": float,
          "depth_to_m": float,
          "thickness_m": float,
          "original_description": string (original description as written in the source document),
          "english_lithology": string (standardized English geological name),
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
1. ALWAYS read every single layer interval (depth from - depth to) meticulously.
2. If the document describes multiple boreholes (e.g. summary table or multiple drilling logs/profiles), include EACH borehole as an item in the "boreholes" array.
3. If an individual borehole has handwritten stratum logs, extract the EXACT layer boundaries and descriptions.
4. Translate any foreign geological term accurately into the standard DIN 4023 classification and USCS group.
5. All numeric values must be numbers (float/int), not strings with units. If a value is unknown, use null.
6. Return JSON only."""

class UniversalBoreholePipeline:
    """
    Universal ingestion and standardization pipeline supporting ALL file types
    (PDF, Images, DOCX, XLSX/CSV, TXT) in ANY language, always outputting standard Herrenknecht JSON.
    """
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("MISTRAL_API_KEY")
        if not self.api_key:
            raise ValueError("MISTRAL_API_KEY is not configured in .env")
        self.client = Mistral(api_key=self.api_key)
        self.dataset_dir = Path(os.getenv("DATASET_PATH", r"C:\Users\aravm\Downloads\HKBoreholeChallenge_Data_BFH2026"))

    def resolve_file(self, file_input: Union[str, Path]) -> Path:
        """Dynamically resolve any input path across filesystem or dataset directory."""
        path = Path(file_input)
        if path.is_absolute() and path.exists():
            return path
        
        # Check relative to current working directory
        if path.exists():
            return path.resolve()
            
        # Check in dataset dir
        if self.dataset_dir.exists():
            direct_candidate = self.dataset_dir / path
            if direct_candidate.exists():
                return direct_candidate
            
            bh_candidate = self.dataset_dir / "BoreholeData" / path
            if bh_candidate.exists():
                return bh_candidate
                
            # Search recursively anywhere in dataset_dir
            matches = list(self.dataset_dir.glob(f"**/{path.name}"))
            if matches:
                return matches[0]
                
        raise FileNotFoundError(f"Cannot resolve borehole document: {file_input}")

    def _file_hash(self, path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        return h.hexdigest()[:16]

    def extract_document(self, file_input: Union[str, Path], force_refresh: bool = False, max_pages: int = 25) -> Dict[str, Any]:
        """
        Universal extraction function:
        1. Ingests any document format (PDF, DOCX, JPG, PNG, TIFF, BMP, XLSX, CSV, TXT).
        2. Performs Mistral OCR 2503 layout parsing or native tabular extraction.
        3. Uses Mistral Structured AI to map into official Herrenknecht Borehole JSON.
        4. Validates and normalizes to guarantee 100% compliant JSON output.
        """
        file_path = self.resolve_file(file_input)
        f_hash = self._file_hash(file_path)
        cache_file = CACHE_DIR / f"universal_{file_path.stem}_{f_hash}.json"

        if cache_file.exists() and not force_refresh:
            print(f"[CACHE HIT] Loading standardized JSON for {file_path.name}")
            with open(cache_file, "r", encoding="utf-8") as f:
                return json.load(f)

        print(f"[PROCESSING] Ingesting {file_path.name} ({file_path.stat().st_size / 1024:.1f} KB)...")

        # Step 1: Universal Extraction to Structured Markdown / Tables
        raw_markdown = self._extract_to_markdown(file_path, max_pages=max_pages)

        # Step 2: Universal Standardization to Herrenknecht JSON Schema
        print(f"[STANDARDIZING] Transforming extracted layout to Herrenknecht Borehole JSON...")
        raw_json = self._standardize_to_herrenknecht_json(file_path.name, raw_markdown)

        # Step 3: Strict Schema Normalization & Validation
        standardized_json = self._normalize_borehole_json(raw_json, file_path.name)

        # Cache valid JSON output
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(standardized_json, f, indent=2, ensure_ascii=False)

        print(f"[SUCCESS] Standardized JSON cached to: {cache_file.name}")
        return standardized_json

    def _extract_to_markdown(self, file_path: Path, max_pages: int = 25) -> str:
        """Universal parser for any file type into clean markdown tables / text."""
        ext = file_path.suffix.lower()

        # 1. Plain Text / Logs
        if ext in [".txt", ".log", ".dat", ".las"]:
            print(f"[UNIVERSAL] Reading text/log data directly...")
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()

        # 2. Spreadsheets & CSV
        if ext in [".xlsx", ".xls", ".csv", ".tsv"]:
            print(f"[UNIVERSAL] Extracting spreadsheet tables...")
            import pandas as pd
            parts = []
            if ext in [".csv", ".tsv"]:
                sep = "\t" if ext == ".tsv" else ","
                df = pd.read_csv(file_path, sep=sep)
                parts.append(df.to_markdown(index=False))
            else:
                excel_file = pd.ExcelFile(file_path)
                for sheet in excel_file.sheet_names:
                    df = pd.read_excel(excel_file, sheet_name=sheet)
                    parts.append(f"\n### Sheet: {sheet}\n")
                    parts.append(df.to_markdown(index=False))
            return "\n\n".join(parts)

        # 3. Word Documents (DOCX)
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

        # 4. Images (JPG, PNG, TIFF, BMP, WEBP)
        if ext in [".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"]:
            print(f"[MISTRAL OCR 2503] Processing image...")
            if ext in [".bmp", ".tiff", ".tif", ".webp"]:
                # Convert to PNG in memory for OCR compatibility
                img = Image.open(file_path)
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                mime = "image/png"
            else:
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

        # 5. PDFs (Multi-page, Scanned, Handwritten, Digital)
        if ext == ".pdf":
            print(f"[MISTRAL OCR 2503] Uploading and scanning PDF...")
            import fitz
            doc = fitz.open(file_path)
            doc_len = len(doc)
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
        text_payload = markdown_content
        # Support up to 250,000 characters (well within Mistral's 128k token context window)
        if len(text_payload) > 250000:
            text_payload = text_payload[:250000] + "\n\n[TRUNCATED TO PREVENT TOKEN OVERFLOW]"

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
        except json.JSONDecodeError:
            # Fallback if wrapped in markdown
            if "```" in content:
                parts = content.split("```")
                for p in parts:
                    p = p.strip()
                    if p.startswith("json"):
                        p = p[4:].strip()
                    try:
                        return json.loads(p)
                    except json.JSONDecodeError:
                        continue
            raise ValueError("Failed to parse valid JSON from AI response")

        return parsed_json

    def _normalize_borehole_json(self, data: Dict[str, Any], filename: str) -> Dict[str, Any]:
        """
        Enforces 100% strict adherence to the Herrenknecht JSON specification.
        Guarantees that all required keys exist and types are correctly cast.
        """
        doc_info = data.get("document_info", {})
        doc_info.setdefault("file_name", filename)
        doc_info.setdefault("source_language", "English")
        doc_info.setdefault("confidence_score", 0.90)

        boreholes = data.get("boreholes", [])
        # If the LLM returned a single borehole at top level
        if not boreholes and "metadata" in data:
            boreholes = [data]

        normalized_boreholes = []
        for bh in boreholes:
            meta = bh.get("metadata", {})
            meta.setdefault("borehole_id", "BH-01")
            meta.setdefault("borehole_name", meta.get("borehole_id"))
            meta.setdefault("location_name", None)
            meta.setdefault("country", None)
            meta.setdefault("project_name", None)
            meta.setdefault("project_id", None)
            meta.setdefault("client", None)
            meta.setdefault("drilling_contractor", None)
            meta.setdefault("driller_name", None)
            meta.setdefault("drilling_date", None)
            meta.setdefault("surface_elevation_mASL", None)
            
            coords = meta.get("coordinates", {})
            if not isinstance(coords, dict):
                coords = {}
            coords.setdefault("latitude", None)
            coords.setdefault("longitude", None)
            coords.setdefault("local_x", None)
            coords.setdefault("local_y", None)
            coords.setdefault("coordinate_system", "WGS84")
            meta["coordinates"] = coords

            strat = bh.get("stratigraphy", [])
            normalized_strat = []
            max_depth = 0.0

            for layer in strat:
                d_from = float(layer.get("depth_from_m") or 0.0)
                d_to = float(layer.get("depth_to_m") or d_from)
                thick = float(layer.get("thickness_m") or round(d_to - d_from, 2))
                max_depth = max(max_depth, d_to)

                # Determine DIN 4023 hatching code if missing or generic
                din_code = layer.get("din4023_code") or "Sand"
                desc = (layer.get("english_lithology") or layer.get("original_description") or "").lower()
                if din_code not in ["Topsoil", "Fill", "Clay", "Silt", "Sand", "Gravel", "Clay/Till", "Sandstone", "Limestone", "Granite", "Gneiss", "Chalk", "Peat"]:
                    if "fill" in desc or "asphalt" in desc:
                        din_code = "Fill"
                    elif "granite" in desc or "igneous" in desc:
                        din_code = "Granite"
                    elif "gneiss" in desc or "fjell" in desc:
                        din_code = "Gneiss"
                    elif "limestone" in desc or "calc" in desc:
                        din_code = "Limestone"
                    elif "sandstone" in desc:
                        din_code = "Sandstone"
                    elif "clay" in desc or "leire" in desc or "argil" in desc:
                        din_code = "Clay"
                    elif "gravel" in desc or "grus" in desc or "grava" in desc:
                        din_code = "Gravel"
                    elif "silt" in desc:
                        din_code = "Silt"
                    else:
                        din_code = "Sand"

                normalized_strat.append({
                    "depth_from_m": d_from,
                    "depth_to_m": d_to,
                    "thickness_m": thick,
                    "original_description": layer.get("original_description") or "",
                    "english_lithology": layer.get("english_lithology") or layer.get("original_description") or "Subsurface stratum",
                    "din4023_code": din_code,
                    "uscs_group": layer.get("uscs_group") or "SP",
                    "consistency_density": layer.get("consistency_density"),
                    "rqd_pct": float(layer["rqd_pct"]) if layer.get("rqd_pct") is not None else None,
                    "core_recovery_pct": float(layer["core_recovery_pct"]) if layer.get("core_recovery_pct") is not None else None,
                    "spt_n_value": int(layer["spt_n_value"]) if layer.get("spt_n_value") is not None else None,
                    "water_table_m": float(layer["water_table_m"]) if layer.get("water_table_m") is not None else None,
                    "ucs_mpa": float(layer["ucs_mpa"]) if layer.get("ucs_mpa") is not None else None
                })

            if meta.get("borehole_depth_m") is None and max_depth > 0:
                meta["borehole_depth_m"] = round(max_depth, 2)

            geotech = bh.get("geotechnical_tests", {})
            if not isinstance(geotech, dict):
                geotech = {}
            geotech.setdefault("water_content_pct", None)
            geotech.setdefault("density_kn_m3", None)
            geotech.setdefault("max_ucs_mpa", None)
            geotech.setdefault("cai_cerchar_abrasivity", None)
            geotech.setdefault("rqd_pct", None)
            geotech.setdefault("friction_angle_deg", None)
            geotech.setdefault("cohesion_kpa", None)
            geotech.setdefault("water_table_m", None)

            tbm = bh.get("tbm_engineering_assessment", {})
            if not isinstance(tbm, dict):
                tbm = {}
            tbm.setdefault("cutter_abrasivity_risk", "Moderate")
            tbm.setdefault("face_stability_risk", "Stable")
            tbm.setdefault("water_ingress_risk", "Dry / Minor")
            tbm.setdefault("recommended_tbm_mode", "Earth Pressure Balance (EPB)")

            normalized_boreholes.append({
                "metadata": meta,
                "stratigraphy": normalized_strat,
                "geotechnical_tests": geotech,
                "tbm_engineering_assessment": tbm
            })

        doc_info["total_boreholes_found"] = len(normalized_boreholes)

        return {
            "document_info": doc_info,
            "boreholes": normalized_boreholes
        }
