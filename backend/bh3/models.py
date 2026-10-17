"""Core data model shared by all pipeline stages.

Coordinates: every page is expressed in *page units* (PDF points, 72 per inch,
origin top-left, y grows downward). OCR output from rendered images is scaled
back into the same unit system so vector text and OCR text are interchangeable.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional
import re

NUM_RE = re.compile(r"^[+-]?\d{1,4}([.,]\d{1,3})?$")


def parse_number(s: str) -> Optional[float]:
    """Parse '0,40', '0.40m', '+17,42', '-10', '>30' (→ None), '1.80m'."""
    t = s.strip().rstrip("m").rstrip("M").replace("−", "-")
    if NUM_RE.match(t):
        return float(t.replace(",", "."))
    return None


@dataclass
class Word:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    conf: float = 1.0          # 1.0 for vector text, OCR confidence (0..1) otherwise
    source: str = "text"       # "text" | "ocr"

    @property
    def xc(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def yc(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    @property
    def number(self) -> Optional[float]:
        return parse_number(self.text)

    def overlaps(self, other: "Word") -> float:
        ix = max(0.0, min(self.x1, other.x1) - max(self.x0, other.x0))
        iy = max(0.0, min(self.y1, other.y1) - max(self.y0, other.y0))
        inter = ix * iy
        a = (self.x1 - self.x0) * (self.y1 - self.y0)
        b = (other.x1 - other.x0) * (other.y1 - other.y0)
        return inter / max(1e-6, min(a, b))


@dataclass
class Segment:
    """Axis-aligned ruling line."""
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def horizontal(self) -> bool:
        return abs(self.y1 - self.y0) < 2.0 and abs(self.x1 - self.x0) > 8

    @property
    def vertical(self) -> bool:
        return abs(self.x1 - self.x0) < 2.0 and abs(self.y1 - self.y0) > 8

    @property
    def length(self) -> float:
        return max(abs(self.x1 - self.x0), abs(self.y1 - self.y0))


@dataclass
class Page:
    doc_id: str
    source_file: str
    page_no: int                      # 1-based
    width: float
    height: float
    words: list[Word] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)
    has_text_layer: bool = False
    image_area_ratio: float = 0.0     # fraction of page covered by embedded raster images
    # filled by triage
    page_class: str = "unknown"
    class_score: float = 0.0
    features: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    def hlines(self, min_len: float = 20) -> list[Segment]:
        return [s for s in self.segments if s.horizontal and s.length >= min_len]

    def vlines(self, min_len: float = 20) -> list[Segment]:
        return [s for s in self.segments if s.vertical and s.length >= min_len]

    def lines_of_text(self, ytol: float = 3.0) -> list[list[Word]]:
        """Group words into visual text lines by y-centre."""
        ws = sorted(self.words, key=lambda w: (w.yc, w.x0))
        lines: list[list[Word]] = []
        for w in ws:
            if lines and abs(lines[-1][-1].yc - w.yc) <= max(ytol, 0.5 * w.h):
                lines[-1].append(w)
            else:
                lines.append([w])
        for ln in lines:
            ln.sort(key=lambda w: w.x0)
        return lines


@dataclass
class Provenance:
    file: str
    page: int
    y0: float = 0.0
    y1: float = 0.0
    x0: float = 0.0
    x1: float = 0.0
    method: str = "geometry"   # geometry | header-alias | llm | ocr
    confidence: float = 1.0


@dataclass
class Layer:
    top: float
    bottom: float
    description: str
    prov: Provenance
    # filled by LLM normaliser
    lithology: Optional[str] = None
    soil_unit: Optional[str] = None       # USCS / EngineeringSoilUnit
    color: Optional[str] = None
    consistency: Optional[str] = None
    moisture: Optional[str] = None
    stratigraphic_name: Optional[str] = None
    geologic_age: Optional[str] = None
    is_rock: Optional[bool] = None
    norm_confidence: Optional[float] = None
    # filled by bh3.din (DIN 4023 petrography)
    din_code: Optional[str] = None
    din_color: Optional[str] = None
    din_pattern: Optional[str] = None
    din_source: Optional[str] = None
    symbol: Optional[str] = None          # hatch pattern as described by the vision model (--symbols)


@dataclass
class PointValue:
    kind: str                 # SPT | RQD | TCR | SCR | SAMPLE | GWL
    depth: float
    value: Any
    prov: Provenance
    depth_to: Optional[float] = None
    label: Optional[str] = None


@dataclass
class Borehole:
    borehole_id: str
    metadata: dict[str, Any] = field(default_factory=dict)      # keys follow BoreholeDataFormat
    meta_prov: dict[str, Provenance] = field(default_factory=dict)
    layers: list[Layer] = field(default_factory=list)
    points: list[PointValue] = field(default_factory=list)
    pages: list[int] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)
    source_file: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


METADATA_FIELDS = [
    "BoreholeID", "BoreholeName", "LocationName", "StartDate", "EndDate",
    "ProjectID", "ProjectName", "Surface Elevation", "X-Coordinate", "Y-Coordinate",
    "CoordinateSystem", "BoreholeDepth", "BoreholeLength", "Notes",
]

LOG_FIELDS = [
    "StratigraphicName", "EngineeringSoilUnit", "GeologicAge", "Lithology/SoilName",
    "Soil/Rockprofile", "Core", "SampleName", "SampleDepth", "TotalCoreRecovery",
    "RQD", "SPT", "Groundwaterlevel",
]
