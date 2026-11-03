"""Conservative whole-line extraction from OCR text; never reviewed evidence."""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import re
from typing import Optional


@dataclass(frozen=True)
class Basis:
    value: Decimal
    unit: str


@dataclass(frozen=True)
class Nutrient:
    value: Optional[Decimal] = None
    unit: Optional[str] = None
    basis: Optional[Basis] = None
    confidence: str = "none"
    requires_human_review: bool = True


@dataclass(frozen=True)
class LabelParse:
    serving_basis: Optional[Basis]
    nutrients: dict[str, Nutrient]
    basis_conflict: bool = False
    confidence: str = "low"
    requires_human_review: bool = True


_NUMBER = r"(\d[\d.,]*)"
_UNIT = r"([a-zA-Zก-๙.]+)"
_HTML_TAG = re.compile(r"</?[a-z][^>]*>", re.I)
_NUTRIENTS = {
    "energy_kcal": (r"energy|พลังงาน", {"kcal": "kcal", "กิโลแคลอรี": "kcal"}),
    "protein_g": (r"protein|โปรตีน", {"g": "g", "กรัม": "g"}),
    "sodium_mg": (r"sodium|โซเดียม", {"mg": "mg", "มก": "mg", "มิลลิกรัม": "mg"}),
    "potassium_mg": (r"potassium|โพแทสเซียม", {"mg": "mg", "มก": "mg", "มิลลิกรัม": "mg"}),
    "phosphorus_mg": (r"phosphorus|ฟอสฟอรัส", {"mg": "mg", "มก": "mg", "มิลลิกรัม": "mg"}),
}
_SERVING_START = re.compile(r"^\s*(?:serving\s*size|หนึ่งหน่วยบริโภค)", re.I)
_SERVING_LINE = re.compile(rf"^\s*(?:serving\s*size|หนึ่งหน่วยบริโภค)\s*[:：]?\s*{_NUMBER}\s*{_UNIT}\s*$", re.I)
_HEADER_SERVING = re.compile(r"^\s*(?:nutrition\s*)?per\s+(?:one\s+)?serving\s*$", re.I)
_HEADER_METRIC = re.compile(r"^\s*(?:nutrition\s*)?per\s*100\s*(g|grams|กรัม|ml|มล\.?|มิลลิลิตร)\s*$", re.I)
_HEADER_THAI_SERVING = re.compile(r"^\s*(?:คุณค่าทางโภชนาการ\s*)?ต่อ\s*(?:หนึ่งหน่วยบริโภค)\s*$", re.I)
_HEADER_THAI_METRIC = re.compile(r"^\s*(?:คุณค่าทางโภชนาการ\s*)?ต่อ\s*100\s*(g|grams|กรัม|ml|มล\.?|มิลลิลิตร)\s*$", re.I)
_BASIS_TEXT = re.compile(r"\bper\s+(?:one\s+)?serving\b|\bper\s*100\s*(?:g|grams|ml)\b|ต่อ\s*(?:หนึ่งหน่วยบริโภค|100\s*(?:กรัม|มล))", re.I)
_BOUND = re.compile(r"\bor\s+(?:less|more|lower|higher)\b|\bless\s+than\b|\b(?:at\s+most|at\s+least)\b|หรือน้อยกว่า|หรือต่ำกว่า|หรือมากกว่า|ไม่เกิน|ไม่น้อยกว่า|อย่างน้อย|ขึ้นไป", re.I)
_GDA = re.compile(r"\bGDA\b|ร้อยละ|%Thai\s*RDI", re.I)
_INEQUALITY = re.compile(r"[<>≤≥]\s*\d")


class _TableText(HTMLParser):
    """Collect text from HTML table cells only; HTMLParser does not fetch entities."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.table_depth = 0
        self.ignored_depth = 0
        self.cell: Optional[list[str]] = None
        self.row: Optional[list[str]] = None
        self.rows: list[list[str]] = []
        self.table_count = 0
        self.invalid = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "figure"}:
            if self.cell is not None:
                self.cell.append(" ")
            self.ignored_depth += 1
            return
        if self.ignored_depth:
            return
        if tag == "table":
            if self.table_depth or self.table_count:
                self.invalid = True
                return
            self.table_depth = 1
            self.table_count += 1
        elif self.table_depth and tag == "tr":
            if self.row is not None or self.cell is not None:
                self.invalid = True
            self.row = []
        elif self.table_depth and tag in {"td", "th"}:
            if self.row is None or self.cell is not None or any(
                name in {"colspan", "rowspan"} for name, _ in attrs
            ):
                self.invalid = True
            self.cell = []
        elif self.table_depth and tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "figure"} and self.ignored_depth:
            self.ignored_depth -= 1
            if not self.ignored_depth and self.cell is not None:
                self.cell.append(" ")
            return
        if self.ignored_depth:
            return
        if tag == "table":
            if not self.table_depth or self.row is not None or self.cell is not None:
                self.invalid = True
            self.table_depth = 0
        elif self.table_depth and tag in {"td", "th"}:
            if self.cell is None or self.row is None:
                self.invalid = True
                return
            value = re.sub(r"\s+", " ", "".join(self.cell)).strip()
            self.row.append(value)
            self.cell = None
        elif self.table_depth and tag == "tr":
            if self.row is None or self.cell is not None:
                self.invalid = True
                return
            self.rows.append(self.row)
            self.row = None

    def handle_data(self, data: str) -> None:
        if self.table_depth and not self.ignored_depth and self.cell is not None:
            self.cell.append(data)


def _html_table_lines(text: str) -> list[str]:
    parser = _TableText()
    parser.feed(text)
    parser.close()
    if parser.invalid or parser.table_count != 1 or parser.table_depth or parser.row or parser.cell:
        return []
    lines = []
    for row in parser.rows:
        cells = row  # Keep empty positions; dropping one can shift values into the wrong column.
        if not cells:
            continue
        if len(cells) > 2:
            return []
        # A header cell can share its row with a label cell; keep the recognized
        # basis exact so conservative header validation remains effective.
        headers = [cell for cell in cells if _header_basis(cell) is not None]
        if headers:
            if any(
                cell not in headers and (
                    re.search(r"\d", cell)
                    or _SERVING_START.match(cell)
                    or any(_is_nutrient_start(cell, label) for label, _ in _NUTRIENTS.values())
                )
                for cell in cells
            ):
                return []
            lines.extend(headers)
        elif len(cells) == 1:
            lines.append(cells[0])
        elif cells[0] and (
            _SERVING_START.match(cells[0])
            or any(_is_nutrient_start(cells[0], label) for label, _ in _NUTRIENTS.values())
        ):
            lines.append(" ".join(cells))
    return lines


def _decimal(text: str) -> Decimal:
    if re.fullmatch(r"\d+", text):
        return Decimal(text)
    if re.fullmatch(r"\d+[.,]\d{1,2}", text):
        return Decimal(text.replace(",", "."))
    raise InvalidOperation


def _header_basis(line: str) -> Optional[Basis]:
    if _HEADER_SERVING.fullmatch(line) or _HEADER_THAI_SERVING.fullmatch(line):
        return Basis(Decimal(1), "serving")
    match = _HEADER_METRIC.fullmatch(line) or _HEADER_THAI_METRIC.fullmatch(line)
    if match:
        unit = match.group(1).lower().rstrip(".")
        return Basis(Decimal(100), "ml" if unit in {"ml", "มล", "มิลลิลิตร"} else "g")
    return None


def _full_section_header(line: str) -> bool:
    return bool(re.match(r"^\s*(?:nutrition\b|คุณค่าทางโภชนาการ)", line, re.I))


def _is_header_candidate(line: str) -> bool:
    return bool(re.match(r"^\s*(?:nutrition\b|คุณค่าทางโภชนาการ|per\b|ต่อ\s*(?:หนึ่ง|100))", line, re.I)
                and _BASIS_TEXT.search(line))


def _is_nutrient_start(line: str, label: str) -> bool:
    return bool(re.match(rf"^\s*(?:{label})(?=$|\s|[:：])", line, re.I))


def _serving_basis(text: str) -> Optional[Basis]:
    lines = [line for line in text.splitlines() if _SERVING_START.match(line)]
    if len(lines) != 1:
        return None
    match = _SERVING_LINE.fullmatch(lines[0])
    if not match:
        return None
    unit = match.group(2).lower().rstrip(".")
    normalized = {"g": "g", "grams": "g", "กรัม": "g", "ml": "ml", "มล": "ml", "มิลลิลิตร": "ml", "pack": "pack", "ซอง": "pack", "ชิ้น": "piece"}.get(unit)
    if normalized is None:
        return None
    try:
        value = _decimal(match.group(1))
    except InvalidOperation:
        return None
    return Basis(value, normalized) if value > 0 else None


def _shared_basis(text: str) -> tuple[Optional[Basis], bool]:
    bases = []
    conflict = False
    for line in text.splitlines():
        if any(_is_nutrient_start(line, label) for label, _ in _NUTRIENTS.values()):
            continue
        basis = _header_basis(line)
        if basis is not None:
            bases.append(basis)
        elif _is_header_candidate(line):
            conflict = True
    if bases and any(item != bases[0] for item in bases):
        conflict = True
    return (bases[0] if bases and not conflict else None), conflict


def _row_pattern(label: str) -> re.Pattern:
    basis_suffix = r"(?:\s*(?:per\s+(?:one\s+)?serving|ต่อ\s*หนึ่งหน่วยบริโภค|per\s*100\s*(?:g|grams|กรัม|ml|มล\.?|มิลลิลิตร)|ต่อ\s*100\s*(?:g|grams|กรัม|ml|มล\.?|มิลลิลิตร)))?"
    return re.compile(rf"^\s*(?:{label})\s*[:：]?\s*{_NUMBER}\s*{_UNIT}{basis_suffix}\s*$", re.I)


def _row_basis(line: str) -> Optional[Basis]:
    if re.search(r"(?:per\s+(?:one\s+)?serving|ต่อ\s*หนึ่งหน่วยบริโภค)\s*$", line, re.I):
        return Basis(Decimal(1), "serving")
    match = re.search(r"(?:per|ต่อ)\s*100\s*(g|grams|กรัม|ml|มล\.?|มิลลิลิตร)\s*$", line, re.I)
    if not match:
        return None
    unit = match.group(1).lower().rstrip(".")
    return Basis(Decimal(100), "ml" if unit in {"ml", "มล", "มิลลิลิตร"} else "g")


def parse_nutrition_label(text: str) -> LabelParse:
    """Parse exact whole-line values; missing or ambiguous fields stay unknown."""
    if not isinstance(text, str):
        raise TypeError("OCR text must be a string")
    if _HTML_TAG.search(text):
        text = "\n".join(_html_table_lines(text))
    serving = _serving_basis(text)
    shared_basis, conflicting_headers = _shared_basis(text)
    occurrences = {key: 0 for key in _NUTRIENTS}
    extracted: dict[str, list[tuple[Decimal, str, Basis]]] = {key: [] for key in _NUTRIENTS}
    blocked = False

    for line in text.splitlines():
        header = _header_basis(line)
        if header is not None and (not blocked or _full_section_header(line)):
            blocked = False
            continue
        if blocked:
            continue
        if _GDA.search(line):
            blocked = True
            continue

        for key, (label, units) in _NUTRIENTS.items():
            if not _is_nutrient_start(line, label):
                continue
            occurrences[key] += 1
            if _INEQUALITY.search(line) or "%" in line:
                blocked = blocked or bool(_INEQUALITY.search(line))
                continue
            match = _row_pattern(label).fullmatch(line)
            if not match or _BOUND.search(line):
                continue
            value_text, unit_text = match.group(1), match.group(2)
            unit = units.get(unit_text.lower().rstrip("."))
            if unit is None:
                continue
            basis = _row_basis(line) or shared_basis
            if (basis is None or conflicting_headers
                    or (shared_basis is not None and basis != shared_basis)):
                continue
            try:
                extracted[key].append((_decimal(value_text), unit, basis))
            except InvalidOperation:
                continue

    nutrients = {}
    for key, values in extracted.items():
        if occurrences[key] == 1 and len(values) == 1:
            value, unit, basis = values[0]
            nutrients[key] = Nutrient(value, unit, basis, "low")
        else:
            nutrients[key] = Nutrient()
    return LabelParse(serving, nutrients, conflicting_headers)
