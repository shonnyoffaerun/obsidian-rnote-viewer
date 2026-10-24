import {
  AffineTransform,
  BrushStroke,
  ParsedRnoteDocument,
  RenderOptions,
  RnoteColor,
  ShapeRect,
  ShapeStroke,
  StrokeStyleConfig,
  TextStroke,
  BitmapImage,
  VectorImage,
} from "./types";

/**
 * Formats a floating-point number to at most 2 decimal places to keep SVG compact and fast.
 */
function fmt(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return (Math.round(n * 100) / 100).toString();
}

/**
 * Escapes text for XML/SVG inclusion.
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Converts an Rnote color definition to a valid CSS color string.
 */
export function colorToCss(color?: RnoteColor | null, defaultColor = "#000000"): string {
  if (!color) return defaultColor;

  if (typeof color === "string") {
    return color;
  }

  if (Array.isArray(color)) {
    const r = color[0] <= 1 ? Math.round(color[0] * 255) : Math.round(color[0]);
    const g = color[1] <= 1 ? Math.round(color[1] * 255) : Math.round(color[1]);
    const b = color[2] <= 1 ? Math.round(color[2] * 255) : Math.round(color[2]);
    const a = color[3] !== undefined ? (color[3] <= 1 ? color[3] : color[3] / 255) : 1;
    return a < 1 ? `rgba(${r}, ${g}, ${b}, ${fmt(a)})` : `rgb(${r}, ${g}, ${b})`;
  }

  if (typeof color === "object") {
    const r = color.r <= 1 ? Math.round(color.r * 255) : Math.round(color.r);
    const g = color.g <= 1 ? Math.round(color.g * 255) : Math.round(color.g);
    const b = color.b <= 1 ? Math.round(color.b * 255) : Math.round(color.b);
    const a = color.a !== undefined ? (color.a <= 1 ? color.a : color.a / 255) : 1;
    return a < 1 ? `rgba(${r}, ${g}, ${b}, ${fmt(a)})` : `rgb(${r}, ${g}, ${b})`;
  }

  return defaultColor;
}

/**
 * Extracts stroke style properties whether stored in smooth/rough/textured or at root.
 */
export function extractStyle(style?: StrokeStyleConfig): {
  strokeWidth: number;
  strokeColor: string;
  fillColor: string;
  strokeStyle: string;
  lineCap: string;
  pressureCurve: string;
} {
  const inner =
    style?.smooth ??
    style?.rough ??
    style?.textured ??
    (style as Record<string, unknown> | undefined) ??
    {};

  const strokeWidth = typeof inner.stroke_width === "number" ? Math.max(0.5, inner.stroke_width) : 2.0;
  const strokeColor = colorToCss(inner.stroke_color as RnoteColor | undefined, "#222222");
  const fillColor = inner.fill_color ? colorToCss(inner.fill_color as RnoteColor) : "none";
  const innerRec = inner as Record<string, unknown>;
  const strokeStyle =
    typeof inner.stroke_style === "string"
      ? inner.stroke_style
      : typeof innerRec.line_style === "string"
      ? innerRec.line_style
      : "solid";
  const rawCap =
    typeof innerRec.line_cap === "string"
      ? innerRec.line_cap
      : "round";
  const lineCap = rawCap === "straight" ? "butt" : rawCap === "square" ? "square" : "round";
  const pressureCurve =
    typeof innerRec.pressure_curve === "string"
      ? innerRec.pressure_curve
      : "linear";

  return { strokeWidth, strokeColor, fillColor, strokeStyle, lineCap, pressureCurve };
}

/**
 * Normalizes any Rnote transform representation into standard 6 SVG matrix coefficients:
 * [a, b, c, d, e, f] where:
 * x' = a*x + c*y + e
 * y' = b*x + d*y + f
 */
export function normalizeTransform(
  transform: unknown
): [number, number, number, number, number, number] | null {
  if (!transform) return null;

  // If nested in { affine: ... } or { transform: ... }
  if (typeof transform === "object" && !Array.isArray(transform)) {
    const obj = transform as Record<string, unknown>;
    if (obj.affine) return normalizeTransform(obj.affine);
    if (obj.transform) return normalizeTransform(obj.transform);

    // glam DAffine2 struct format: { matrix2: { x_axis: [a, b], y_axis: [c, d] }, translation: [tx, ty] }
    if (obj.matrix2 && typeof obj.matrix2 === "object" && obj.translation) {
      const m2 = obj.matrix2 as Record<string, [number, number]>;
      const trans = obj.translation as [number, number];
      if (Array.isArray(m2.x_axis) && Array.isArray(m2.y_axis) && Array.isArray(trans)) {
        return [m2.x_axis[0], m2.x_axis[1], m2.y_axis[0], m2.y_axis[1], trans[0], trans[1]];
      }
    }
    return null;
  }

  if (Array.isArray(transform)) {
    // 6 numbers: [a, b, c, d, tx, ty]
    if (transform.length === 6) {
      return [
        transform[0],
        transform[1],
        transform[2],
        transform[3],
        transform[4],
        transform[5],
      ];
    }
    // 9 numbers: [m0, m1, m2, m3, m4, m5, m6, m7, m8] (3x3 column-major matrix)
    if (transform.length >= 8) {
      return [
        transform[0], // a
        transform[1], // b
        transform[3], // c
        transform[4], // d
        transform[6], // e (tx)
        transform[7], // f (ty)
      ];
    }
  }

  return null;
}

/**
 * Applies affine transformation to a 2D point [x, y].
 */
export function applyTransform(
  matrix: unknown,
  pt: [number, number]
): [number, number] {
  const norm = normalizeTransform(matrix);
  if (!norm) return pt;
  const [a, b, c, d, e, f] = norm;
  const x = pt[0];
  const y = pt[1];
  return [a * x + c * y + e, b * x + d * y + f];
}

/**
 * Converts affine transform matrix to SVG transform string: matrix(a, b, c, d, e, f).
 */
export function transformMatrixToSvg(matrix: unknown): string | undefined {
  const norm = normalizeTransform(matrix);
  if (!norm) return undefined;
  const [a, b, c, d, e, f] = norm;
  // If identity matrix, omit transform attribute
  if (
    Math.abs(a - 1) < 1e-5 &&
    Math.abs(b) < 1e-5 &&
    Math.abs(c) < 1e-5 &&
    Math.abs(d - 1) < 1e-5 &&
    Math.abs(e) < 1e-5 &&
    Math.abs(f) < 1e-5
  ) {
    return undefined;
  }
  return `matrix(${fmt(a)},${fmt(b)},${fmt(c)},${fmt(d)},${fmt(e)},${fmt(f)})`;
}

/**
 * Bounding box tracker to calculate minimal enclosing viewBox.
 */
export class BoundingBoxTracker {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  addPoint(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  addPoints(points: [number, number][], matrix?: unknown): void {
    for (const pt of points) {
      const [tx, ty] = matrix ? applyTransform(matrix, pt) : pt;
      this.addPoint(tx, ty);
    }
  }

  hasBounds(): boolean {
    return (
      Number.isFinite(this.minX) &&
      Number.isFinite(this.minY) &&
      Number.isFinite(this.maxX) &&
      Number.isFinite(this.maxY)
    );
  }

  getBox(padding = 24): { minX: number; minY: number; width: number; height: number; viewBox: string } {
    if (!this.hasBounds()) {
      return {
        minX: 0,
        minY: 0,
        width: 800,
        height: 600,
        viewBox: "0 0 800 600",
      };
    }

    const minX = Math.floor(this.minX - padding);
    const minY = Math.floor(this.minY - padding);
    const width = Math.max(1, Math.ceil(this.maxX - this.minX + padding * 2));
    const height = Math.max(1, Math.ceil(this.maxY - this.minY + padding * 2));

    return {
      minX,
      minY,
      width,
      height,
      viewBox: `${minX} ${minY} ${width} ${height}`,
    };
  }
}

/**
 * Renders a BrushStroke as a single continuous path with the Fine-Ink handwriting algorithm.
 * Uses non-linear dynamic range compression and pen calibration to ensure razor-sharp, thin,
 * natural handwriting without bloated stroke widths or cracks.
 */
export function renderBrushStroke(
  brush: BrushStroke,
  tracker: BoundingBoxTracker,
  options?: RenderOptions
): string | null {
  const path = brush.path;
  if (!path || !path.start) return null;

  const startPos = path.start.pos;
  if (!startPos || !Array.isArray(startPos)) return null;

  const { strokeWidth, strokeColor, lineCap, pressureCurve } = extractStyle(brush.style);
  const startPressure = typeof path.start.pressure === "number" ? path.start.pressure : 0.5;

  const scale = typeof options?.strokeWidthScale === "number" ? options.strokeWidthScale : 0.45;
  const baseWidth = strokeWidth * scale;

  const segments = path.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    let factor = 0.75;
    if (pressureCurve === "linear") factor = Math.pow(Math.max(0.1, startPressure), 1.4);
    else if (pressureCurve === "sqrt") factor = Math.sqrt(startPressure);
    else if (pressureCurve === "cbrt") factor = Math.cbrt(startPressure);
    else if (pressureCurve === "pow2") factor = startPressure * startPressure;
    else if (pressureCurve === "pow3") factor = startPressure * startPressure * startPressure;
    else if (pressureCurve === "const") factor = 0.75;
    const dotW = Math.max(0.35, Number((baseWidth * factor).toFixed(2)));
    const half = dotW / 2;
    tracker.addPoint(startPos[0] - half, startPos[1] - half);
    tracker.addPoint(startPos[0] + half, startPos[1] + half);
    return `<circle cx="${fmt(startPos[0])}" cy="${fmt(startPos[1])}" r="${fmt(
      dotW / 2
    )}" fill="${strokeColor}" stroke="none"/>`;
  }

  // Calculate length-weighted average pressure across the entire stroke
  let sumP = startPressure;
  let countP = 1;
  let weightedSumP = 0;
  let totalLength = 0;
  let prevPos: [number, number] = [startPos[0], startPos[1]];
  let prevP = startPressure;

  for (const seg of segments) {
    const end =
      seg.quadbezto?.end?.pos ??
      seg.cubbezto?.end?.pos ??
      seg.lineto?.end?.pos ??
      seg.end?.pos ??
      seg.pos;
    const p =
      typeof seg.quadbezto?.end?.pressure === "number"
        ? seg.quadbezto.end.pressure
        : typeof seg.cubbezto?.end?.pressure === "number"
        ? seg.cubbezto.end.pressure
        : typeof seg.lineto?.end?.pressure === "number"
        ? seg.lineto.end.pressure
        : typeof seg.end?.pressure === "number"
        ? seg.end.pressure
        : typeof seg.pressure === "number"
        ? seg.pressure
        : prevP;

    if (end) {
      const dx = end[0] - prevPos[0];
      const dy = end[1] - prevPos[1];
      const dist = Math.hypot(dx, dy);
      weightedSumP += ((prevP + p) / 2) * dist;
      totalLength += dist;
      prevPos = [end[0], end[1]];
    }
    sumP += p;
    countP++;
    prevP = p;
  }

  const strokePressure = totalLength > 0 ? weightedSumP / totalLength : sumP / countP;

  // Fine-Ink Non-Linear Pressure Response:
  // Maps standard handwriting pressures into crisp, fine lines while preserving accent dynamics
  let factor = 0.75;
  if (pressureCurve === "linear") {
    factor = Math.pow(Math.max(0.08, Math.min(1.0, strokePressure)), 1.4);
  } else if (pressureCurve === "sqrt") {
    factor = Math.sqrt(strokePressure);
  } else if (pressureCurve === "cbrt") {
    factor = Math.cbrt(strokePressure);
  } else if (pressureCurve === "pow2") {
    factor = strokePressure * strokePressure;
  } else if (pressureCurve === "pow3") {
    factor = strokePressure * strokePressure * strokePressure;
  } else if (pressureCurve === "const") {
    factor = 0.75;
  }

  const effectiveWidth = Math.max(0.35, Number((baseWidth * factor).toFixed(2)));
  const halfWidth = Math.max(0.18, effectiveWidth / 2);

  tracker.addPoint(startPos[0] - halfWidth, startPos[1] - halfWidth);
  tracker.addPoint(startPos[0] + halfWidth, startPos[1] + halfWidth);

  const dParts: string[] = [`M ${fmt(startPos[0])} ${fmt(startPos[1])}`];
  let currX = startPos[0];
  let currY = startPos[1];
  let hasSegments = false;

  for (const seg of segments) {
    if (seg.quadbezto?.end?.pos) {
      const end = seg.quadbezto.end.pos;
      const cp = seg.quadbezto.cp ?? end;
      dParts.push(`Q ${fmt(cp[0])} ${fmt(cp[1])}, ${fmt(end[0])} ${fmt(end[1])}`);

      tracker.addPoint(cp[0] - halfWidth, cp[1] - halfWidth);
      tracker.addPoint(cp[0] + halfWidth, cp[1] + halfWidth);
      tracker.addPoint(end[0] - halfWidth, end[1] - halfWidth);
      tracker.addPoint(end[0] + halfWidth, end[1] + halfWidth);

      currX = end[0];
      currY = end[1];
      hasSegments = true;
    } else if (seg.cubbezto?.end?.pos) {
      const end = seg.cubbezto.end.pos;
      const cp1 = seg.cubbezto.cp1 ?? end;
      const cp2 = seg.cubbezto.cp2 ?? end;
      dParts.push(
        `C ${fmt(cp1[0])} ${fmt(cp1[1])}, ${fmt(cp2[0])} ${fmt(cp2[1])}, ${fmt(end[0])} ${fmt(
          end[1]
        )}`
      );

      tracker.addPoint(cp1[0] - halfWidth, cp1[1] - halfWidth);
      tracker.addPoint(cp1[0] + halfWidth, cp1[1] + halfWidth);
      tracker.addPoint(cp2[0] - halfWidth, cp2[1] - halfWidth);
      tracker.addPoint(cp2[0] + halfWidth, cp2[1] + halfWidth);
      tracker.addPoint(end[0] - halfWidth, end[1] - halfWidth);
      tracker.addPoint(end[0] + halfWidth, end[1] + halfWidth);

      currX = end[0];
      currY = end[1];
      hasSegments = true;
    } else {
      const end = seg.lineto?.end?.pos ?? seg.end?.pos ?? seg.pos;
      if (end) {
        if (Math.abs(end[0] - currX) > 0.01 || Math.abs(end[1] - currY) > 0.01) {
          dParts.push(`L ${fmt(end[0])} ${fmt(end[1])}`);

          tracker.addPoint(end[0] - halfWidth, end[1] - halfWidth);
          tracker.addPoint(end[0] + halfWidth, end[1] + halfWidth);

          currX = end[0];
          currY = end[1];
          hasSegments = true;
        }
      }
    }
  }

  if (!hasSegments) {
    return `<circle cx="${fmt(startPos[0])}" cy="${fmt(startPos[1])}" r="${fmt(
      halfWidth
    )}" fill="${strokeColor}" stroke="none"/>`;
  }

  const d = dParts.join(" ");
  return `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${fmt(
    effectiveWidth
  )}" stroke-linecap="${lineCap}" stroke-linejoin="round"/>`;
}

/**
 * Renders a ShapeStroke (line, arrow, rect, ellipse, cubbez, quadbez, poly_line, polygon).
 */
export function renderShapeStroke(
  shapeStroke: ShapeStroke,
  tracker: BoundingBoxTracker,
  options?: RenderOptions
): string | null {
  const shape = shapeStroke.shape;
  if (!shape) return null;

  const rawStyle = extractStyle(shapeStroke.style);
  const scale = typeof options?.strokeWidthScale === "number" ? Math.max(0.4, options.strokeWidthScale * 1.5) : 0.75;
  const strokeWidth = Math.max(0.5, Number((rawStyle.strokeWidth * scale).toFixed(2)));
  const { strokeColor, fillColor, strokeStyle } = rawStyle;

  let strokeDash = "";
  if (strokeStyle === "dashed") {
    strokeDash = ` stroke-dasharray="${fmt(strokeWidth * 3)} ${fmt(strokeWidth * 2)}"`;
  } else if (strokeStyle === "dotted") {
    strokeDash = ` stroke-dasharray="${fmt(strokeWidth)} ${fmt(strokeWidth * 1.5)}"`;
  }

  // 1. Line
  if (shape.line) {
    const { start, end } = shape.line;
    const matrix = shape.line.affine ?? shape.line.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    tracker.addPoints([start, end], matrix);
    return `<line x1="${fmt(start[0])}" y1="${fmt(start[1])}" x2="${fmt(end[0])}" y2="${fmt(
      end[1]
    )}" stroke="${strokeColor}" stroke-width="${fmt(strokeWidth)}"${strokeDash}${transformStr}/>`;
  }

  // 2. Arrow
  if (shape.arrow) {
    const { start, tip } = shape.arrow;
    const matrix = shape.arrow.affine ?? shape.arrow.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    const dx = tip[0] - start[0];
    const dy = tip[1] - start[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    const headLen = Math.min(len * 0.45, Math.max(12, strokeWidth * 3.5));
    const headWidth = Math.min(len * 0.3, Math.max(6, strokeWidth * 2.0));

    const baseX = tip[0] - ux * headLen;
    const baseY = tip[1] - uy * headLen;

    const wing1: [number, number] = [baseX + nx * headWidth, baseY + ny * headWidth];
    const wing2: [number, number] = [baseX - nx * headWidth, baseY - ny * headWidth];

    tracker.addPoints([start, tip, wing1, wing2], matrix);

    const linePart = `<line x1="${fmt(start[0])}" y1="${fmt(start[1])}" x2="${fmt(baseX)}" y2="${fmt(
      baseY
    )}" stroke="${strokeColor}" stroke-width="${fmt(strokeWidth)}"${strokeDash}/>`;

    const headPart = `<polygon points="${fmt(tip[0])},${fmt(tip[1])} ${fmt(wing1[0])},${fmt(
      wing1[1]
    )} ${fmt(wing2[0])},${fmt(wing2[1])}" fill="${strokeColor}" stroke="none"/>`;

    return `<g${transformStr}>${linePart}${headPart}</g>`;
  }

  // 3. Rect / Rectangle
  const rect = shape.rect ?? shape.rectangle;
  if (rect) {
    const matrix = rect.affine ?? rect.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    let hx = 50;
    let hy = 50;
    if (rect.cuboid?.half_extents) {
      hx = rect.cuboid.half_extents[0];
      hy = rect.cuboid.half_extents[1];
    } else if (rect.half_extents) {
      hx = rect.half_extents[0];
      hy = rect.half_extents[1];
    } else if (rect.size) {
      hx = rect.size[0] / 2;
      hy = rect.size[1] / 2;
    }

    const corners: [number, number][] = [
      [-hx, -hy],
      [hx, -hy],
      [hx, hy],
      [-hx, hy],
    ];
    tracker.addPoints(corners, matrix);

    const rx = rect.border_radius ? ` rx="${fmt(rect.border_radius)}"` : "";
    return `<rect x="${fmt(-hx)}" y="${fmt(-hy)}" width="${fmt(hx * 2)}" height="${fmt(
      hy * 2
    )}"${rx} fill="${fillColor}" stroke="${strokeColor}" stroke-width="${fmt(
      strokeWidth
    )}"${strokeDash}${transformStr}/>`;
  }

  // 4. Ellipse
  if (shape.ellipse) {
    const ell = shape.ellipse;
    const matrix = ell.affine ?? ell.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    const rx = ell.radii[0];
    const ry = ell.radii[1];
    const cx = ell.center ? ell.center[0] : 0;
    const cy = ell.center ? ell.center[1] : 0;

    const bounds: [number, number][] = [
      [cx - rx, cy - ry],
      [cx + rx, cy - ry],
      [cx + rx, cy + ry],
      [cx - rx, cy + ry],
    ];
    tracker.addPoints(bounds, matrix);

    return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(
      ry
    )}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${fmt(
      strokeWidth
    )}"${strokeDash}${transformStr}/>`;
  }

  // 5. Cubic Bézier
  const cubbez = shape.cubbez ?? shape.cubic_bezier;
  if (cubbez) {
    const matrix = cubbez.affine ?? cubbez.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    const p0 = cubbez.start ?? cubbez.p0 ?? cubbez.points?.[0] ?? [0, 0];
    const p1 = cubbez.cp1 ?? cubbez.p1 ?? cubbez.points?.[1] ?? [0, 0];
    const p2 = cubbez.cp2 ?? cubbez.p2 ?? cubbez.points?.[2] ?? [0, 0];
    const p3 = cubbez.end ?? cubbez.p3 ?? cubbez.points?.[3] ?? [0, 0];

    tracker.addPoints([p0, p1, p2, p3], matrix);

    const d = `M ${fmt(p0[0])} ${fmt(p0[1])} C ${fmt(p1[0])} ${fmt(p1[1])}, ${fmt(p2[0])} ${fmt(
      p2[1]
    )}, ${fmt(p3[0])} ${fmt(p3[1])}`;

    return `<path d="${d}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${fmt(
      strokeWidth
    )}"${strokeDash}${transformStr}/>`;
  }

  // 6. Quadratic Bézier
  const quadbez = shape.quadbez ?? shape.quadratic_bezier;
  if (quadbez) {
    const matrix = quadbez.affine ?? quadbez.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    const p0 = quadbez.start ?? quadbez.p0 ?? quadbez.points?.[0] ?? [0, 0];
    const p1 = quadbez.cp ?? quadbez.p1 ?? quadbez.points?.[1] ?? [0, 0];
    const p2 = quadbez.end ?? quadbez.p2 ?? quadbez.points?.[2] ?? [0, 0];

    tracker.addPoints([p0, p1, p2], matrix);

    const d = `M ${fmt(p0[0])} ${fmt(p0[1])} Q ${fmt(p1[0])} ${fmt(p1[1])}, ${fmt(p2[0])} ${fmt(
      p2[1]
    )}`;

    return `<path d="${d}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${fmt(
      strokeWidth
    )}"${strokeDash}${transformStr}/>`;
  }

  // 7. Polyline
  const polyline = shape.polyline ?? shape.poly_line;
  if (polyline) {
    const matrix = polyline.affine ?? polyline.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    const allPts: [number, number][] = [];
    if (polyline.start) allPts.push(polyline.start);
    if (Array.isArray(polyline.path)) allPts.push(...polyline.path);
    if (Array.isArray(polyline.points)) allPts.push(...polyline.points);

    if (allPts.length > 0) {
      tracker.addPoints(allPts, matrix);
      const ptsStr = allPts.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(" ");
      return `<polyline points="${ptsStr}" fill="none" stroke="${strokeColor}" stroke-width="${fmt(
        strokeWidth
      )}"${strokeDash}${transformStr}/>`;
    }
  }

  // 8. Polygon
  if (shape.polygon) {
    const poly = shape.polygon;
    const matrix = poly.affine ?? poly.transform ?? shapeStroke.affine ?? shapeStroke.transform;
    const transformAttr = transformMatrixToSvg(matrix);
    const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

    const allPts: [number, number][] = [];
    if (poly.start) allPts.push(poly.start);
    if (Array.isArray(poly.path)) allPts.push(...poly.path);
    if (Array.isArray(poly.points)) allPts.push(...poly.points);

    if (allPts.length > 0) {
      tracker.addPoints(allPts, matrix);
      const ptsStr = allPts.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(" ");
      return `<polygon points="${ptsStr}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${fmt(
        strokeWidth
      )}"${strokeDash}${transformStr}/>`;
    }
  }

  return null;
}

/**
 * Renders a TextStroke with multi-line support and font stylings.
 */
export function renderTextStroke(textStroke: TextStroke, tracker: BoundingBoxTracker): string | null {
  if (!textStroke.text) return null;

  const style = textStroke.text_style;
  const fontSize = typeof style?.font_size === "number" ? style.font_size : 16;
  const color = colorToCss(style?.color, "#222222");
  const fontFamily = style?.font_family ?? "sans-serif";
  const matrix = textStroke.affine ?? textStroke.transform;
  const transformAttr = transformMatrixToSvg(matrix);
  const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

  const lines = textStroke.text.split("\n");
  const maxLineLen = Math.max(...lines.map((l) => l.length), 1);
  const estWidth = maxLineLen * (fontSize * 0.65);
  const estHeight = lines.length * (fontSize * 1.25);

  const corners: [number, number][] = [
    [0, -fontSize],
    [estWidth, -fontSize],
    [estWidth, estHeight - fontSize],
    [0, estHeight - fontSize],
  ];
  tracker.addPoints(corners, matrix);

  let tspans = "";
  for (let i = 0; i < lines.length; i++) {
    const dy = i === 0 ? "0" : "1.25em";
    tspans += `<tspan x="0" dy="${dy}">${escapeXml(lines[i])}</tspan>`;
  }

  return `<text font-family="${escapeXml(fontFamily)}" font-size="${fmt(
    fontSize
  )}" fill="${color}"${transformStr}>${tspans}</text>`;
}

/**
 * Clean, safe Base64 encoder without deprecated unescape or globalThis.
 * Uses window.btoa with btoa fallback for Node test environments.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    return window.btoa(binary);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  return "";
}

function stringToBase64(str: string): string {
  return uint8ArrayToBase64(new TextEncoder().encode(str));
}

/**
 * Converts image data into a valid data URI if possible.
 */
function normalizeImageUri(bitmap: BitmapImage): string | null {
  const rawData = (bitmap.image as { data?: unknown })?.data ?? bitmap.data;
  if (!rawData) return null;

  if (typeof rawData === "string") {
    if (rawData.startsWith("data:")) return rawData;
    if (rawData.startsWith("iVBORw0KGgo")) return `data:image/png;base64,${rawData}`;
    if (rawData.startsWith("/9j/")) return `data:image/jpeg;base64,${rawData}`;
    if (rawData.startsWith("UklGR")) return `data:image/webp;base64,${rawData}`;
    return `data:image/png;base64,${rawData}`;
  }

  if (Array.isArray(rawData) || rawData instanceof Uint8Array) {
    const bytes = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    const isPng =
      bytes.length > 4 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47;
    const mime = isPng ? "image/png" : "image/jpeg";
    const b64 = uint8ArrayToBase64(bytes);
    return `data:${mime};base64,${b64}`;
  }

  return null;
}

/**
 * Renders a BitmapImage to an SVG image tag with affine transform matrix.
 */
export function renderBitmapImage(bitmap: BitmapImage, tracker: BoundingBoxTracker): string | null {
  const uri = normalizeImageUri(bitmap);
  if (!uri) return null;

  const imgObj = bitmap.image as Record<string, unknown> | undefined;
  const rect = bitmap.rectangle ?? (imgObj?.rectangle as ShapeRect | undefined);
  const matrix =
    rect?.affine ??
    rect?.transform ??
    (imgObj?.affine as AffineTransform | undefined) ??
    bitmap.affine ??
    bitmap.transform;
  const transformAttr = transformMatrixToSvg(matrix);
  const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

  let x = 0;
  let y = 0;
  let w = bitmap.pixel_width ?? (imgObj?.pixel_width as number | undefined) ?? 100;
  let h = bitmap.pixel_height ?? (imgObj?.pixel_height as number | undefined) ?? 100;

  const halfExtents = rect?.cuboid?.half_extents ?? rect?.half_extents ?? bitmap.half_extents;
  if (halfExtents) {
    const hx = halfExtents[0];
    const hy = halfExtents[1];
    x = -hx;
    y = -hy;
    w = hx * 2;
    h = hy * 2;
  }

  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  tracker.addPoints(corners, matrix);

  return `<image x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(
    h
  )}" href="${uri}" preserveAspectRatio="none"${transformStr}/>`;
}

/**
 * Renders an embedded VectorImage (SVG content) with affine transform.
 */
export function renderVectorImage(vectorImg: VectorImage, tracker: BoundingBoxTracker): string | null {
  if (!vectorImg.svg_data) return null;

  const rect = vectorImg.rectangle;
  const matrix = rect?.affine ?? rect?.transform ?? vectorImg.affine ?? vectorImg.transform;
  const transformAttr = transformMatrixToSvg(matrix);
  const transformStr = transformAttr ? ` transform="${transformAttr}"` : "";

  let x = 0;
  let y = 0;
  let w = vectorImg.intrinsic_size?.[0] ?? 200;
  let h = vectorImg.intrinsic_size?.[1] ?? 200;

  const halfExtents = rect?.cuboid?.half_extents ?? rect?.half_extents;
  if (halfExtents) {
    const hx = halfExtents[0];
    const hy = halfExtents[1];
    x = -hx;
    y = -hy;
    w = hx * 2;
    h = hy * 2;
  }

  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  tracker.addPoints(corners, matrix);

  const b64 = stringToBase64(vectorImg.svg_data);
  const dataUri = `data:image/svg+xml;base64,${b64}`;

  return `<image x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(
    h
  )}" href="${dataUri}" preserveAspectRatio="none"${transformStr}/>`;
}

/**
 * Generates background patterns (dots, grid, lines, isometric).
 */
function buildPatternDefs(
  patternRaw: string | Record<string, unknown>,
  size: unknown,
  color: string,
  rectArea: { x: number; y: number; width: number; height: number }
): { defs: string; rect: string } | null {
  const pattern =
    typeof patternRaw === "string"
      ? patternRaw.toLowerCase()
      : typeof patternRaw === "object" && patternRaw !== null
      ? Object.keys(patternRaw)[0]?.toLowerCase()
      : "";

  if (!pattern || pattern === "none") return null;

  let sX = 24;
  let sY = 24;
  if (typeof size === "number" && Number.isFinite(size)) {
    sX = size;
    sY = size;
  } else if (Array.isArray(size)) {
    if (typeof size[0] === "number" && Number.isFinite(size[0])) sX = size[0];
    if (typeof size[1] === "number" && Number.isFinite(size[1])) sY = size[1];
    else sY = sX;
  }
  sX = Math.max(8, sX);
  sY = Math.max(8, sY);

  const rx = fmt(rectArea.x);
  const ry = fmt(rectArea.y);
  const rw = fmt(rectArea.width);
  const rh = fmt(rectArea.height);

  if (pattern === "dots") {
    const defs = `<defs><pattern id="rnote-bg-dots" width="${fmt(sX)}" height="${fmt(
      sY
    )}" patternUnits="userSpaceOnUse"><circle cx="${fmt(sX / 2)}" cy="${fmt(
      sY / 2
    )}" r="1.2" fill="${color}"/></pattern></defs>`;
    const rect = `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="url(#rnote-bg-dots)"/>`;
    return { defs, rect };
  }

  if (pattern === "grid") {
    const defs = `<defs><pattern id="rnote-bg-grid" width="${fmt(sX)}" height="${fmt(
      sY
    )}" patternUnits="userSpaceOnUse"><path d="M ${fmt(sX)} 0 L 0 0 0 ${fmt(
      sY
    )}" fill="none" stroke="${color}" stroke-width="0.75"/></pattern></defs>`;
    const rect = `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="url(#rnote-bg-grid)"/>`;
    return { defs, rect };
  }

  if (pattern === "lines") {
    const defs = `<defs><pattern id="rnote-bg-lines" width="${fmt(sX)}" height="${fmt(
      sY
    )}" patternUnits="userSpaceOnUse"><line x1="0" y1="${fmt(sY)}" x2="${fmt(sX)}" y2="${fmt(
      sY
    )}" stroke="${color}" stroke-width="0.75"/></pattern></defs>`;
    const rect = `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="url(#rnote-bg-lines)"/>`;
    return { defs, rect };
  }

  if (pattern === "isometric") {
    const defs = `<defs><pattern id="rnote-bg-isometric" width="${fmt(sX)}" height="${fmt(
      sY
    )}" patternUnits="userSpaceOnUse"><g fill="${color}"><circle cx="0" cy="0" r="1.2"/><circle cx="${fmt(
      sX
    )}" cy="0" r="1.2"/><circle cx="${fmt(sX / 2)}" cy="${fmt(sY / 2)}" r="1.2"/><circle cx="0" cy="${fmt(
      sY
    )}" r="1.2"/><circle cx="${fmt(sX)}" cy="${fmt(sY)}" r="1.2"/></g></pattern></defs>`;
    const rect = `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="url(#rnote-bg-isometric)"/>`;
    return { defs, rect };
  }

  return null;
}

/**
 * Main high-speed SVG renderer:
 * Converts ParsedRnoteDocument to responsive, pure SVG in a single-pass traversal.
 */
export function renderRnoteToSvg(
  doc: ParsedRnoteDocument,
  options: RenderOptions = {}
): { svg: string; viewBox: string; width: number; height: number } {
  const tracker = new BoundingBoxTracker();
  const elements: string[] = [];

  for (const comp of doc.components) {
    const val = comp.value ?? comp;
    if (!val) continue;

    if (val.brushstroke) {
      const el = renderBrushStroke(val.brushstroke, tracker, options);
      if (el) elements.push(el);
    } else if (val.shapestroke) {
      const el = renderShapeStroke(val.shapestroke, tracker, options);
      if (el) elements.push(el);
    } else if (val.textstroke) {
      const el = renderTextStroke(val.textstroke, tracker);
      if (el) elements.push(el);
    } else if (val.bitmapimage) {
      const el = renderBitmapImage(val.bitmapimage, tracker);
      if (el) elements.push(el);
    } else if (val.vectorimage) {
      const el = renderVectorImage(val.vectorimage, tracker);
      if (el) elements.push(el);
    }
  }

  // Determine paper layout dimensions (A4 or custom format)
  const hasFormat = Boolean(doc.format?.width && doc.format?.height);
  const pageWidth = doc.format?.width ?? 793.7;
  const pageHeight = doc.format?.height ?? 1122.5;

  let totalPaperHeight = pageHeight;
  if (tracker.hasBounds() && tracker.maxY > pageHeight) {
    const pages = Math.max(1, Math.ceil(tracker.maxY / pageHeight));
    totalPaperHeight = pages * pageHeight;
  }

  // Calculate enclosing document bounds
  let docMinX = 0;
  let docMinY = 0;
  let docMaxX = pageWidth;
  let docMaxY = totalPaperHeight;

  if (tracker.hasBounds()) {
    if (hasFormat) {
      docMinX = Math.min(0, tracker.minX);
      docMinY = Math.min(0, tracker.minY);
      docMaxX = Math.max(pageWidth, tracker.maxX);
      docMaxY = Math.max(totalPaperHeight, tracker.maxY);
    } else {
      docMinX = tracker.minX;
      docMinY = tracker.minY;
      docMaxX = tracker.maxX;
      docMaxY = tracker.maxY;
    }
  } else if (doc.documentBounds) {
    docMinX = doc.documentBounds.x;
    docMinY = doc.documentBounds.y;
    docMaxX = doc.documentBounds.x + doc.documentBounds.width;
    docMaxY = doc.documentBounds.y + doc.documentBounds.height;
  }

  const padding = options.padding ?? 24;
  const boxMinX = Math.floor(docMinX - padding);
  const boxMinY = Math.floor(docMinY - padding);
  const boxWidth = Math.max(1, Math.ceil(docMaxX - docMinX + padding * 2));
  const boxHeight = Math.max(1, Math.ceil(docMaxY - docMinY + padding * 2));
  const viewBox = `${boxMinX} ${boxMinY} ${boxWidth} ${boxHeight}`;

  // Paper & Background styling
  const bgMode = options.backgroundMode ?? "rnote-native";
  const isDark = Boolean(options.isDarkTheme);

  const docBgColor = doc.background?.color ? colorToCss(doc.background.color) : undefined;
  const docPatternColor = doc.background?.pattern_color
    ? colorToCss(doc.background.pattern_color)
    : undefined;

  let bgFill = "#ffffff";
  let pColor = "rgba(0, 0, 0, 0.15)";
  let borderColor = "rgba(0, 0, 0, 0.15)";

  if (bgMode === "rnote-native") {
    bgFill = docBgColor ?? "#ffffff";
    pColor = docPatternColor ?? (isDark ? "rgba(255, 255, 255, 0.18)" : "rgba(0, 0, 0, 0.15)");
    borderColor = doc.format?.border_color
      ? colorToCss(doc.format.border_color)
      : isDark
      ? "rgba(255, 255, 255, 0.18)"
      : "rgba(0, 0, 0, 0.18)";
  } else if (bgMode === "adaptive") {
    if (isDark) {
      bgFill = docBgColor ?? "#1e1e1e";
      pColor = docPatternColor ?? "rgba(255, 255, 255, 0.12)";
      borderColor = "rgba(255, 255, 255, 0.18)";
    } else {
      bgFill = docBgColor ?? "#ffffff";
      pColor = docPatternColor ?? "rgba(0, 0, 0, 0.12)";
      borderColor = "rgba(0, 0, 0, 0.18)";
    }
  } else if (bgMode === "light") {
    bgFill = "#ffffff";
    pColor = "rgba(0, 0, 0, 0.12)";
    borderColor = "rgba(0, 0, 0, 0.18)";
  } else if (bgMode === "dark") {
    bgFill = "#1e1e1e";
    pColor = "rgba(255, 255, 255, 0.12)";
    borderColor = "rgba(255, 255, 255, 0.18)";
  } else if (bgMode === "transparent") {
    bgFill = "transparent";
    pColor = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.12)";
    borderColor = isDark ? "rgba(255, 255, 255, 0.18)" : "rgba(0, 0, 0, 0.18)";
  }

  // Paper sheet geometry
  const paperX = hasFormat ? 0 : docMinX;
  const paperY = hasFormat ? 0 : docMinY;
  const paperW = hasFormat ? pageWidth : docMaxX - docMinX;
  const paperH = hasFormat ? totalPaperHeight : docMaxY - docMinY;

  // Background pattern
  let patternDefs = "";
  let patternRect = "";
  if (doc.background?.pattern) {
    const res = buildPatternDefs(doc.background.pattern, doc.background.pattern_size, pColor, {
      x: paperX,
      y: paperY,
      width: paperW,
      height: paperH,
    });
    if (res) {
      patternDefs = res.defs;
      patternRect = res.rect;
    }
  }

  // Paper background and border rect
  let paperRect = "";
  if (bgFill !== "transparent") {
    paperRect = `<rect x="${fmt(paperX)}" y="${fmt(paperY)}" width="${fmt(paperW)}" height="${fmt(
      paperH
    )}" fill="${bgFill}" stroke="${borderColor}" stroke-width="1" rx="2" class="rnote-paper-sheet"/>`;
  } else if (borderColor) {
    paperRect = `<rect x="${fmt(paperX)}" y="${fmt(paperY)}" width="${fmt(paperW)}" height="${fmt(
      paperH
    )}" fill="none" stroke="${borderColor}" stroke-width="1" rx="2" class="rnote-paper-sheet"/>`;
  }

  // Multi-page divider lines
  const dividers: string[] = [];
  if (hasFormat && totalPaperHeight > pageHeight) {
    const pages = Math.round(totalPaperHeight / pageHeight);
    for (let p = 1; p < pages; p++) {
      const dy = p * pageHeight;
      dividers.push(
        `<line x1="0" y1="${fmt(dy)}" x2="${fmt(pageWidth)}" y2="${fmt(
          dy
        )}" stroke="${borderColor}" stroke-dasharray="6 4" stroke-width="1"/>`
      );
    }
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="100%" height="100%" class="rnote-rendered-svg">`,
    patternDefs,
    paperRect,
    patternRect,
    ...dividers,
    ...elements,
    `</svg>`,
  ].join("\n");

  return {
    svg,
    viewBox,
    width: boxWidth,
    height: boxHeight,
  };
}
