"""Bounded JPEG/PNG/WebP decoding, HEIF to JPEG conversion, bbox crops and display previews; no OCR or ORM writes."""
import math
import warnings
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

from recognition.geometry import GeometryError, validate_geometry as _validate_geometry

# MPO is a JPEG with extra frames after the first (iPhone keeps an HDR gain map there): browsers
# show it as a JPEG and every step below uses the first frame only. Other formats must be one frame.
FORMATS = {"JPEG": ("image/jpeg", "jpg"), "MPO": ("image/jpeg", "jpg"), "PNG": ("image/png", "png"), "WEBP": ("image/webp", "webp")}
MULTI_FRAME = {"MPO"}
# HEIF/HEIC is never stored: convert_heif() turns the upload into a JPEG before inspect_image().
HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"}
HEIF_JPEG_QUALITY = 92

register_heif_opener()


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
    if image.format not in MULTI_FRAME and getattr(image, "n_frames", 1) != 1:
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
        supported = (header.startswith((b"\xff\xd8", b"\x89PNG\r\n\x1a\n")) or (header[:4] == b"RIFF" and header[8:12] == b"WEBP")
                     or (header[4:8] == b"ftyp" and header[8:12] in HEIF_BRANDS))
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


def convert_heif(source, destination):
    """convert_heif(source, destination) -> bool; False (nothing written) unless source is HEIF/HEIC.

    Writes an upright metadata-free RGB JPEG of the primary image; checks the pixel limit before
    decoding. The caller treats the JPEG as the upload: inspect_image() checks it again.
    """
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if image.format != "HEIF":
                    return False
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > settings.RECEIPT_IMAGE_MAX_PIXELS:
                    raise ImageError("image_too_large")
                with _upright_rgb(image) as clean:
                    clean.save(destination, format="JPEG", quality=HEIF_JPEG_QUALITY)
        return True
    except ImageError:
        raise
    except UnidentifiedImageError:
        return False  # inspect_image() tells a broken HEIF from an unsupported format.
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ImageError("image_too_large") from None
    except (OSError, ValueError, SyntaxError, EOFError, OverflowError, RuntimeError):
        raise ImageError("invalid_image") from None


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


PREVIEW_WEBP_QUALITY = 80


def write_preview(source, destination, longest, scan=None):
    """write_preview(source, destination, longest: int, scan=None) -> (width, height); display-only WebP.

    Upright (EXIF), RGB on white, metadata-free, longest side at most ``longest`` (never enlarged).
    ``scan`` — ``scan_quad()`` of a crop: the paper is first straightened, text up.
    Only the formats and pixel limit of stored images are read; recognition never uses the result.
    """
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                _header(image)
                if scan is None:  # scan coordinates are of the full-size image
                    # JPEG decodes at 1/2, 1/4 or 1/8 directly: far less work for a big photo.
                    image.draft("RGB", (longest, longest))
                clean = _upright_rgb(image)
                if scan is not None:
                    with clean:
                        clean = clean.transform(scan[0], Image.Transform.PERSPECTIVE, scan[1],
                                                Image.Resampling.BICUBIC, fillcolor="white")
                with clean:
                    clean.thumbnail((longest, longest), Image.Resampling.LANCZOS)
                    clean.save(destination, format="WEBP", quality=PREVIEW_WEBP_QUALITY, method=4)
                    return clean.size
    except ImageError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ImageError("image_too_large") from None
    except (OSError, ValueError, SyntaxError, EOFError, OverflowError):
        raise ImageError("invalid_image") from None


def validate_geometry(bbox, quad=None, rotation_degrees=0):
    """Shared detect/crop contract; preserve text-relative clockwise corner order."""
    try:
        return _validate_geometry(bbox, quad, rotation_degrees)
    except GeometryError:
        raise ImageError("geometry_requires_review") from None


def crop_receipt(source, destination, bbox, *, quad=None, rotation_degrees=0):
    """crop_receipt(upright_path, destination, bbox, *, quad=None, rotation_degrees=0) -> CropInfo.

    Adds 1% of the source dimensions on each edge, clamps, floor/ceil half-open.
    Retains source quad order and signed clockwise text rotation. Crop remains
    rotated; no deskew or perspective rectification is applied.
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


# Display only (recognition.previews): the paper of a crop straightened, as a document scanner shows it.
SCAN_MARGIN = 0.015  # outward on each side: inexact corners do not cut the edge of the text
# Of the bbox width and height. Not an area share: a long receipt turned 25° fills only 38% of its bbox.
SCAN_MIN_SPAN = 0.75
SCAN_MAX_SKEW = 2.0  # longer / shorter of opposite sides: steeper is more likely wrong corners
SCAN_MAX_ASPECT = 20
SCAN_MAX_TURN = 45  # degrees between the top side and rotation_degrees: else the corner order is wrong


def scan_quad(bbox, quad, crop_transform, rotation_degrees=0):
    """scan_quad(bbox, quad, crop_transform, rotation_degrees=0) -> ((width, height), coefficients) | None.

    Pillow ``PERSPECTIVE`` data turning ``crop.png`` into the paper alone, text up: the quad (TL, TR, BR,
    BL relative to the text, source coordinates) mapped to crop pixels by ``crop_transform``, widened by
    SCAN_MARGIN; the size is the longer of each pair of opposite sides. None — show the bbox crop as it is:
    no quad, invalid geometry (not strictly convex and clockwise, outside the bbox), a quad that does not
    span its bbox, a side under 16 px, steep perspective, an absurd shape, corners out of order with the
    text rotation.
    """
    try:
        box, points, rotation = validate_geometry(bbox, quad, rotation_degrees)
        width, height = float(crop_transform["source_width"]), float(crop_transform["source_height"])
        left, top = (float(value) for value in crop_transform["pixel_bbox"][:2])
    except (ImageError, KeyError, TypeError, ValueError):
        return None
    if points is None:
        return None
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = p = [(pt["x"] * width - left, pt["y"] * height - top) for pt in points]
    top_side, right, bottom, left_side = (math.dist(p[i], p[(i + 1) % 4]) for i in range(4))
    across, along = max(top_side, bottom), max(right, left_side)
    xs, ys = [pt["x"] for pt in points], [pt["y"] for pt in points]
    turn = (math.degrees(math.atan2(y1 - y0, x1 - x0)) - rotation + 180) % 360 - 180
    if (max(xs) - min(xs) < SCAN_MIN_SPAN * (box["x_max"] - box["x_min"])
            or max(ys) - min(ys) < SCAN_MIN_SPAN * (box["y_max"] - box["y_min"])
            or min(top_side, right, bottom, left_side) < 16 or abs(turn) > SCAN_MAX_TURN
            or across > SCAN_MAX_SKEW * min(top_side, bottom) or along > SCAN_MAX_SKEW * min(right, left_side)
            or max(across, along) > SCAN_MAX_ASPECT * min(across, along)):
        return None
    # The unit square (u, v) onto the quad (Heckbert, "Fundamentals of Texture Mapping", 1989).
    sx, sy = x0 - x1 + x2 - x3, y0 - y1 + y2 - y3
    dx1, dx2, dy1, dy2 = x1 - x2, x3 - x2, y1 - y2, y3 - y2
    den = dx1 * dy2 - dx2 * dy1
    g, h = (sx * dy2 - dx2 * sy) / den, (dx1 * sy - sx * dy1) / den
    a, b, d, e = x1 - x0 + g * x1, x3 - x0 + h * x3, y1 - y0 + g * y1, y3 - y0 + h * y3
    # Output pixel (X, Y) is u = X * su - m, v = Y * sv - m: the margin extends the plane of the paper.
    m = SCAN_MARGIN
    size = (max(1, round(across * (1 + 2 * m))), max(1, round(along * (1 + 2 * m))))
    su, sv = (1 + 2 * m) / size[0], (1 + 2 * m) / size[1]
    k = 1 - (g + h) * m
    return size, (a * su / k, b * sv / k, (x0 - (a + b) * m) / k, d * su / k, e * sv / k, (y0 - (d + e) * m) / k,
                  g * su / k, h * sv / k)
