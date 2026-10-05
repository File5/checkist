"""Shared detect/crop geometry in EXIF-transposed source coordinates.

quad follows paper TL, TR, BR, BL relative to the text, clockwise with y down.
Its first corner cannot be inferred from frame axes. Cyclic starts are accepted
and retained; bbox cropping does not depend on the first corner. Rotation is
the text angle from upright: positive clockwise, negative counterclockwise,
within [-180, 180] (270 clockwise is -90).
"""
import math


class GeometryError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__("Invalid receipt geometry.")


def _number(value):
    return type(value) in {int, float} and math.isfinite(value)


def validate_geometry(bbox, quad=None, rotation_degrees=0):
    """Validate enclosure and strict clockwise convexity, preserving corner order."""
    keys = {"x_min", "y_min", "x_max", "y_max"}
    if not isinstance(bbox, dict) or set(bbox) != keys or not all(_number(v) and 0 <= v <= 1 for v in bbox.values()):
        raise GeometryError("range")
    box = {key: float(bbox[key]) for key in keys}
    if box["x_min"] >= box["x_max"] or box["y_min"] >= box["y_max"]:
        raise GeometryError("area")
    if not _number(rotation_degrees) or not -180 <= rotation_degrees <= 180:
        raise GeometryError("range")
    points = None
    if quad is not None:
        if not isinstance(quad, (list, tuple)) or len(quad) != 4:
            raise GeometryError("quad_geometry")
        points = []
        for point in quad:
            if not isinstance(point, dict) or set(point) != {"x", "y"} or not all(_number(v) for v in point.values()):
                raise GeometryError("range")
            x, y = float(point["x"]), float(point["y"])
            if not box["x_min"] <= x <= box["x_max"] or not box["y_min"] <= y <= box["y_max"]:
                raise GeometryError("bbox_enclosure")
            points.append({"x": x, "y": y})
        # Positive turns in image coordinates mean clockwise strict convexity.
        # All four also exclude crossings, repeated/collinear points and zero area.
        for index in range(4):
            a, b, c = (points[(index + offset) % 4] for offset in range(3))
            cross = (b["x"] - a["x"]) * (c["y"] - b["y"]) - (b["y"] - a["y"]) * (c["x"] - b["x"])
            if cross <= 0:
                raise GeometryError("quad_geometry")
    return box, points, float(rotation_degrees)
