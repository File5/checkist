"""Bounded JPEG/PNG/WebP decoding and bbox crops; no OCR or ORM writes."""
import math
import warnings
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings
from PIL import Image, ImageOps, UnidentifiedImageError

FORMATS = {"JPEG": ("image/jpeg", "jpg"), "PNG": ("image/png", "png"), "WEBP": ("image/webp", "webp")}


class ImageError(ValueError):
    """Safe code suitable for conversion to an API error; no decoder diagnostics."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ImageInfo:
    content_type: str
    extension: str
    bytes: int
    raw_width: int
    raw_height: int
    width: int
    height: int
    exif_orientation: int


@dataclass(frozen=True)
class CropInfo:
    width: int
    height: int
    bbox: dict
    quad: list | None
    rotation_degrees: float
    crop_transform: dict


def _header(image):
    if image.format not in FORMATS:
        raise ImageError("unsupported_format")
    width, height = image.size
    if width <= 0 or height <= 0 or width * height > settings.RECEIPT_IMAGE_MAX_PIXELS:
        raise ImageError("image_too_large")
    if getattr(image, "n_frames", 1) != 1:
        raise ImageError("invalid_image")
    return width, height


def inspect_image(path):
    """inspect_image(path: PathLike) -> ImageInfo; checks limits before load()."""
    path = Path(path)
    try:
        size = path.stat().st_size
        if size > settings.RECEIPT_IMAGE_MAX_BYTES:
            raise ImageError("file_too_large")
        if not size:
            raise ImageError("invalid_image")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                raw_width, raw_height = _header(image)
                content_type, extension = FORMATS[image.format]
                image.verify()
            with Image.open(path) as image:
                _header(image)
                image.load()  # verify alone does not detect all truncated JPEG/WebP data.
                # PNG getexif() may load the image: call only after verify on the reopened file.
                orientation = image.getexif().get(274, 1)
                if type(orientation) is not int or orientation not in range(1, 9):
                    raise ImageError("invalid_image")
        width, height = (raw_height, raw_width) if orientation in {5, 6, 7, 8} else (raw_width, raw_height)
        return ImageInfo(content_type, extension, size, raw_width, raw_height, width, height, orientation)
    except ImageError:
        raise
    except UnidentifiedImageError:
        with path.open("rb") as stream:
            header = stream.read(12)
        supported = header.startswith((b"\xff\xd8", b"\x89PNG\r\n\x1a\n")) or (header[:4] == b"RIFF" and header[8:12] == b"WEBP")
        raise ImageError("invalid_image" if supported else "unsupported_format") from None
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ImageError("image_too_large") from None
    except (OSError, ValueError, SyntaxError, EOFError, OverflowError):
        raise ImageError("invalid_image") from None


def _upright_rgb(image):
    upright = ImageOps.exif_transpose(image)
    try:
        if upright.mode in {"RGBA", "LA"} or "transparency" in upright.info:
            rgba = upright.convert("RGBA")
            try:
                rgb = Image.new("RGB", upright.size, "white")
                rgb.paste(rgba, mask=rgba.getchannel("A"))
            finally:
                rgba.close()
        else:
            rgb = upright.convert("RGB")
        # A fresh bitmap contains no EXIF, GPS, ICC, comment or client metadata.
        clean = Image.new("RGB", rgb.size)
        clean.paste(rgb)
        rgb.close()
        return clean
    finally:
        upright.close()


def prepare_upright(source, destination):
    """prepare_upright(source, destination) -> ImageInfo; writes metadata-free RGB PNG."""
    info = inspect_image(source)
    try:
        with Image.open(source) as image:
            with _upright_rgb(image) as clean:
                clean.save(destination, format="PNG")
        return info
    except (OSError, ValueError):
        raise ImageError("invalid_image") from None


def _number(value):
    return type(value) in {int, float} and math.isfinite(value)


def validate_geometry(bbox, quad=None, rotation_degrees=0):
    """Validate normalized upright coordinates. Returns canonical (bbox, quad, angle)."""
    keys = {"x_min", "y_min", "x_max", "y_max"}
    if not isinstance(bbox, dict) or set(bbox) != keys or not all(_number(v) and 0 <= v <= 1 for v in bbox.values()):
        raise ImageError("geometry_requires_review")
    box = {key: float(bbox[key]) for key in keys}
    if box["x_min"] >= box["x_max"] or box["y_min"] >= box["y_max"]:
        raise ImageError("geometry_requires_review")
    if not _number(rotation_degrees) or not -180 <= rotation_degrees <= 180:
        raise ImageError("geometry_requires_review")
    points = None
    if quad is not None:
        if not isinstance(quad, (list, tuple)) or len(quad) != 4:
            raise ImageError("geometry_requires_review")
        points = []
        for point in quad:
            if not isinstance(point, dict) or set(point) != {"x", "y"} or not all(_number(v) for v in point.values()):
                raise ImageError("geometry_requires_review")
            x, y = float(point["x"]), float(point["y"])
            if not box["x_min"] <= x <= box["x_max"] or not box["y_min"] <= y <= box["y_max"]:
                raise ImageError("geometry_requires_review")
            points.append({"x": x, "y": y})
        # In image coordinates positive cross products mean clockwise, convex, nonzero area.
        for index in range(4):
            a, b, c = (points[(index + offset) % 4] for offset in range(3))
            cross = (b["x"] - a["x"]) * (c["y"] - b["y"]) - (b["y"] - a["y"]) * (c["x"] - b["x"])
            if cross <= 1e-12:
                raise ImageError("geometry_requires_review")
        if points[0]["x"] + points[0]["y"] > min(point["x"] + point["y"] for point in points) + 1e-12:
            raise ImageError("geometry_requires_review")
    return box, points, float(rotation_degrees)


def crop_receipt(source, destination, bbox, *, quad=None, rotation_degrees=0):
    """crop_receipt(upright_path, destination, bbox, *, quad=None, rotation_degrees=0) -> CropInfo.

    Adds 1% of the source dimensions on each edge, clamps, floor/ceil half-open.
    Retains rotation/quad; does not apply unverified perspective rectification.
    """
    box, points, angle = validate_geometry(bbox, quad, rotation_degrees)
    try:
        with Image.open(source) as image:
            _header(image)
            width, height = image.size
            pixels = (
                math.floor(max(0, box["x_min"] - 0.01) * width),
                math.floor(max(0, box["y_min"] - 0.01) * height),
                math.ceil(min(1, box["x_max"] + 0.01) * width),
                math.ceil(min(1, box["y_max"] + 0.01) * height),
            )
            if pixels[2] <= pixels[0] or pixels[3] <= pixels[1]:
                raise ImageError("geometry_requires_review")
            with image.crop(pixels).convert("RGB") as cropped:
                cropped.info.clear()
                cropped.save(destination, format="PNG")
        transform = {"source_width": width, "source_height": height, "pixel_bbox": list(pixels), "padding": 0.01}
        return CropInfo(pixels[2] - pixels[0], pixels[3] - pixels[1], box, points, angle, transform)
    except ImageError:
        raise
    except (OSError, ValueError, SyntaxError):
        raise ImageError("invalid_image") from None
