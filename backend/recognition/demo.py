"""Deterministic fictional K1 receipts, matching FakeProvider crop geometry.

Only creates MEDIA/demo files; never creates jobs, users or domain records.
"""
import io
import math
import os
import re
import tempfile
from pathlib import Path

from django.conf import settings
from PIL import Image, ImageDraw, ImageFont


class DemoError(ValueError):
    pass


TEXTS = (
    (
        "SYNTHETIC RECEIPT - TEST ONLY", "TESTMARKT GmbH", "Teststrasse 12, 10115 Berlin", "DE  EUR",
        "04.10.2026 14:35:20", "Bon 000123  Kasse 02  Schicht 7", "--------------------------------",
        "MILCH 1 L", "  2 pcs x 1.2900       2.58 A", "APFEL", "  0.500 kg x 2.0000    1.00 A",
        "MINERALWASSER 0.5 L", "  1 pcs x 0.7900       0.79 B", "PFAND zu MINERALWASSER",
        "  1 pcs x 0.2500       0.25 B", "Rabatt MILCH         -0.20", "--------------------------------",
        "SUMME EUR             4.42", "Rabatt gesamt         0.20", "MwSt A 7% NET 3.16 TAX 0.22",
        "MwSt B 19% NET 0.87 TAX 0.17", "Preise inklusive MwSt", "Barzahlung            5.00",
        "Rueckgeld             0.58", "Register TEST-KASSE-02", "TSE Transaktion 98765", "Danke!",
    ),
    (
        "SYNTHETIC RECEIPT - TEST ONLY", "TESTSHOP GmbH", "Beispielweg 4, 20095 Hamburg", "DE  EUR",
        "04.10.2026 16:10:00", "Bon 000777  Kasse 01  Schicht 3", "--------------------------------",
        "BROT", "  1 pcs x 1.5000       1.50 A", "KAESE 200 G", "  2 pcs x 2.2500       4.50 A",
        "--------------------------------", "SUMME EUR             6.00", "MwSt A 7% NET 5.61 TAX 0.39",
        "Preise inklusive MwSt", "Kartenzahlung         6.00", "Register TEST-KASSE-01", "TSE Transaktion 12345", "Danke!",
    ),
)


def _paper(lines):
    paper = Image.new("RGB", (560, 880), "white")
    draw = ImageDraw.Draw(paper)
    # Pillow's bundled font, no platform fonts or external dependencies.
    font = ImageFont.load_default(size=22)
    for index, line in enumerate(lines):
        draw.text((20, 18 + index * 30), line, font=font, fill="black")
    return paper


def rotated_demo_receipts(*, single=False):
    """Known K1 layout: second paper rotated 12 degrees counterclockwise.

    The expanded Pillow tile is 732x978 for a 560x880 paper. Corner positions
    are measured from its centre and remain TL/TR/BR/BL relative to the text.
    This helper supplies deterministic geometry to fake QA, never real OCR.
    """
    width, height = (1000, 1250) if single else (1500, 1250)
    cosine, sine = math.cos(math.radians(-12)), math.sin(math.radians(-12))
    left, top = (120, 80) if single else (740, 80)
    quad = [{"x": (left + 366 + x * cosine - y * sine) / width,
             "y": (top + 489 + x * sine + y * cosine) / height}
            for x, y in ((-280, -440), (280, -440), (280, 440), (-280, 440))]
    rotated = {"id": 1 if single else 2, "quad": quad,
               "bbox": {"x_min": min(p["x"] for p in quad), "y_min": min(p["y"] for p in quad),
                        "x_max": max(p["x"] for p in quad), "y_max": max(p["y"] for p in quad)},
               "rotation_degrees": -12, "confidence": 1, "clipped": False}
    if single:
        return [rotated]
    x1, y1, x2, y2 = 40 / width, 160 / height, 600 / width, 1040 / height
    upright = {"id": 1, "bbox": dict(x_min=x1, y_min=y1, x_max=x2, y_max=y2),
               "quad": [dict(x=x1, y=y1), dict(x=x2, y=y1), dict(x=x2, y=y2), dict(x=x1, y=y2)],
               "rotation_degrees": 0, "confidence": 1, "clipped": False}
    return [upright, rotated]


def seed_demo(*, rotated=False):
    name = str(settings.DATABASES["default"]["NAME"])
    if not re.fullmatch(r"(?:test_[A-Za-z0-9_]+|checkist_qa(?:_[A-Za-z0-9_]+)?)", name):
        raise DemoError("Demo images require a test_* or checkist_qa* database; dev/production is forbidden.")
    root = Path(settings.MEDIA_ROOT).resolve()
    directory = root / "demo"
    if directory.is_symlink() or not directory.resolve().is_relative_to(root):
        raise DemoError("Demo directory must remain inside MEDIA_ROOT.")
    directory.mkdir(parents=True, exist_ok=True)
    with _paper(TEXTS[0]) as first, _paper(TEXTS[1]) as second:
        layouts = (
            ("single.png", (800, 1100), ((first, (120, 100)),)),
            ("double.png", (1500, 1100), ((first, (80, 110)), (second, (820, 70)))),
        )
        tiles = []
        if rotated:
            for paper in (first, second):
                with paper.convert("RGBA") as rgba:
                    tiles.append(rgba.rotate(12, resample=Image.Resampling.BICUBIC, expand=True))
            layouts = (
                ("single_rotated.png", (1000, 1250), ((tiles[0], (120, 80)),)),
                ("double_rotated.png", (1500, 1250), ((first, (40, 160)), (tiles[1], (740, 80)))),
            )
        try:
            return _write_layouts(directory, layouts)
        finally:
            for tile in tiles:
                tile.close()


def _write_layouts(directory, layouts):
    paths = []
    for filename, size, placements in layouts:
        target = directory / filename
        if target.is_symlink():
            raise DemoError("Demo image must not be a symlink.")
        with Image.new("RGB", size, (74, 87, 98)) as image:
            for paper, point in placements:
                image.paste(paper, point, paper if paper.mode == "RGBA" else None)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            data = buffer.getvalue()
        if not target.is_file() or target.read_bytes() != data:
            staged = None
            try:
                with tempfile.NamedTemporaryFile(dir=directory, suffix=".png", delete=False) as stream:
                    staged = Path(stream.name)
                    stream.write(data)
                os.replace(staged, target)
            finally:
                if staged is not None:
                    staged.unlink(missing_ok=True)
        paths.append(target)
    return paths
