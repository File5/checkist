"""R3: paper corners follow text orientation, independent of frame axes."""
import copy
import math
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import SimpleTestCase
from PIL import Image

from recognition.dto import PreparedImage
from recognition.images import ImageError, crop_receipt, validate_geometry
from recognition.providers.fake import detection_payload
from recognition.schema_validation import SchemaValidationError, _schema, validate_detection


def rotated_receipt(angle, *, width=1000, height=1000, paper_width=240, paper_height=300):
    """Rotate pixel coordinates clockwise, then normalize separately by W/H."""
    radians = math.radians(angle)
    cosine, sine = math.cos(radians), math.sin(radians)
    quad = [
        {"x": (width / 2 + x * cosine - y * sine) / width,
         "y": (height / 2 + x * sine + y * cosine) / height}
        for x, y in ((-paper_width / 2, -paper_height / 2),
                     (paper_width / 2, -paper_height / 2),
                     (paper_width / 2, paper_height / 2),
                     (-paper_width / 2, paper_height / 2))
    ]
    return {"id": 1, "quad": quad,
            "bbox": {"x_min": min(p["x"] for p in quad), "y_min": min(p["y"] for p in quad),
                     "x_max": max(p["x"] for p in quad), "y_max": max(p["y"] for p in quad)},
            "rotation_degrees": (angle + 180) % 360 - 180, "confidence": 1, "clipped": False}


class RotatedGeometryTests(SimpleTestCase):
    def assert_detection(self, receipt, *, width=1000, height=1000):
        image = PreparedImage(Path("synthetic.png"), "a" * 64, width, height)
        data = detection_payload(image, 1)
        data["receipts"] = [receipt]
        return validate_detection(data, width=width, height=height)

    def test_prompt_order_passes_detection_and_crop_validation_at_all_rotations(self):
        # x+y on normalized coordinates is aspect dependent: even -12/+30
        # can choose a different first corner on wide/tall source frames.
        cases = ((-12, 2400, 400), (30, 400, 2000), (90, 1000, 1000),
                 (180, 1000, 1000), (270, 1000, 1000))
        for angle, width, height in cases:
            with self.subTest(angle=angle):
                receipt = rotated_receipt(angle, width=width, height=height)
                image = PreparedImage(Path("synthetic.png"), "a" * 64, width, height)
                data = detection_payload(image, 1)
                data["receipts"] = [receipt]
                dto = validate_detection(data, width=width, height=height)
                self.assertEqual(dto.receipts[0].to_dict(), receipt)
                self.assertEqual(validate_geometry(receipt["bbox"], receipt["quad"], receipt["rotation_degrees"]),
                                 (receipt["bbox"], receipt["quad"], receipt["rotation_degrees"]))

    def test_full_turn_with_cyclic_starts_and_different_frame_aspects(self):
        for width, height in ((2400, 400), (400, 2400), (1000, 1000)):
            for angle in range(-180, 181, 3):
                receipt = rotated_receipt(angle, width=width, height=height, paper_width=100, paper_height=200)
                for start in range(4):
                    with self.subTest(size=(width, height), angle=angle, start=start):
                        receipt["quad"] = receipt["quad"][1:] + receipt["quad"][:1]
                        self.assert_detection(receipt, width=width, height=height)
                        self.assertEqual(validate_geometry(receipt["bbox"], receipt["quad"])[1], receipt["quad"])

    def test_skewed_convex_paper_and_loose_bbox_are_valid(self):
        quad = [dict(x=.3, y=.1), dict(x=.9, y=.4), dict(x=.5, y=.9), dict(x=.1, y=.5)]
        receipt = rotated_receipt(30)
        receipt.update(quad=quad, bbox=dict(x_min=0, y_min=0, x_max=1, y_max=1))
        self.assert_detection(receipt)
        self.assertEqual(validate_geometry(receipt["bbox"], quad)[1], quad)
        # Positive area has no arbitrary normalized-area cut-off.
        receipt.update(quad=[dict(x=0, y=0), dict(x=1e-8, y=0), dict(x=1e-8, y=1e-8), dict(x=0, y=1e-8)])
        self.assert_detection(receipt)
        validate_geometry(receipt["bbox"], receipt["quad"])

    def test_both_validators_reject_invalid_polygons_and_enclosure(self):
        receipt = rotated_receipt(30)
        q = receipt["quad"]
        invalid = [list(reversed(q)), [q[0], q[2], q[1], q[3]], [q[0]] * 4,
                   [q[0], q[1], q[1], q[3]],
                   [dict(x=.2, y=.2), dict(x=.4, y=.4), dict(x=.6, y=.6), dict(x=.8, y=.8)],
                   [dict(x=.2, y=.2), dict(x=.8, y=.2), dict(x=.4, y=.4), dict(x=.2, y=.8)],
                   [dict(x=-.1, y=.2), *q[1:]], [dict(x=1.1, y=.2), *q[1:]]]
        for quad in invalid:
            data = copy.deepcopy(receipt)
            data.update(quad=quad, bbox=dict(x_min=0, y_min=0, x_max=1, y_max=1))
            with self.subTest(quad=quad):
                with self.assertRaises(SchemaValidationError):
                    self.assert_detection(data)
                with self.assertRaises(ImageError):
                    validate_geometry(data["bbox"], quad)
        data = copy.deepcopy(receipt)
        data["bbox"]["x_min"] += .001  # Valid quad, bbox clips its leftmost point.
        with self.assertRaises(SchemaValidationError) as error:
            self.assert_detection(data)
        self.assertEqual(error.exception.reason, "bbox_enclosure")
        with self.assertRaises(ImageError):
            validate_geometry(data["bbox"], data["quad"])

    def test_prompt_and_schema_describe_the_validated_order_and_signed_angle(self):
        root = Path(__file__).resolve().parents[1]
        prompt = (root / "prompts/detect.txt").read_text(encoding="utf-8")
        props = _schema("detect")["properties"]["receipts"]["items"]["properties"]
        self.assertIn("TL, TR, BR, BL relative to the text", prompt)
        self.assertIn("TL, TR, BR, BL relative to the text", props["quad"]["description"])
        for phrase in ("positive clockwise", "negative counterclockwise", "270 clockwise is -90"):
            self.assertIn(phrase, prompt)
            self.assertIn(phrase, props["rotation_degrees"]["description"])
        self.assertEqual((props["rotation_degrees"]["minimum"], props["rotation_degrees"]["maximum"]), (-180, 180))
        self.assert_detection(rotated_receipt(270))
        for angle in (-180, 180):
            receipt = rotated_receipt(180)
            receipt["rotation_degrees"] = angle
            self.assert_detection(receipt)
            validate_geometry(receipt["bbox"], receipt["quad"], angle)

    def test_rotated_crop_is_padded_bbox_and_retains_paper_coordinates(self):
        receipt = rotated_receipt(180)
        with TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.png", Path(directory) / "crop.png"
            with Image.new("RGB", (1000, 1000), "white") as image:
                image.save(source)
            crop = crop_receipt(source, target, receipt["bbox"], quad=receipt["quad"],
                                rotation_degrees=receipt["rotation_degrees"])
            self.assertEqual(crop.quad, receipt["quad"])
            self.assertEqual(crop.rotation_degrees, -180)
            box = receipt["bbox"]
            expected = [math.floor((box["x_min"] - .01) * 1000), math.floor((box["y_min"] - .01) * 1000),
                        math.ceil((box["x_max"] + .01) * 1000), math.ceil((box["y_max"] + .01) * 1000)]
            self.assertEqual(crop.crop_transform["pixel_bbox"], expected)
            with Image.open(target) as image:
                self.assertEqual(image.size, (expected[2] - expected[0], expected[3] - expected[1]))
