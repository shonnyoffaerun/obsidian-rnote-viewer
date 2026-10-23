/**
 * Comprehensive TypeScript definitions for the Rnote (.rnote) vector file format,
 * supporting Rnote v0.5, v0.6, v0.9, v0.13, v0.15+, and Obsidian plugin configurations.
 */

// RGBA Color representation: floats 0.0 - 1.0 or array [r, g, b, a]
export interface RnoteColorObj {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export type RnoteColor =
  | RnoteColorObj
  | [number, number, number, number]
  | [number, number, number]
  | string;

// Affine transform matrix in Rnote can be:
// 1. 6 numbers: [a, b, c, d, tx, ty] (glam DAffine2)
// 2. 9 numbers: [m0, m1, m2, m3, m4, m5, m6, m7, m8] (3x3 column-major matrix)
// 3. Object: { affine: number[] } or { matrix2: { x_axis: [a, b], y_axis: [c, d] }, translation: [tx, ty] }
export type AffineTransform = number[];

// --- Stroke Components ---

export interface BrushPoint {
  pos: [number, number];
  pressure?: number;
}

export interface BrushSegmentLineto {
  end: BrushPoint;
}

export interface BrushSegmentQuadbezto {
  cp?: [number, number];
  end: BrushPoint;
}

export interface BrushSegmentCubbezto {
  cp1?: [number, number];
  cp2?: [number, number];
  end: BrushPoint;
}

export interface BrushSegment {
  lineto?: BrushSegmentLineto;
  quadbezto?: BrushSegmentQuadbezto;
  cubbezto?: BrushSegmentCubbezto;
  end?: BrushPoint;
  pos?: [number, number];
  pressure?: number;
}

export interface StyleInner {
  stroke_width?: number;
  stroke_color?: RnoteColor;
  fill_color?: RnoteColor | null;
  stroke_style?: string;
  brush_type?: string;
  smooth_options?: unknown;
}

export interface StrokeStyleConfig extends StyleInner {
  smooth?: StyleInner;
  rough?: StyleInner;
  textured?: StyleInner;
}

export interface BrushStroke {
  path: {
    start: BrushPoint;
    segments: BrushSegment[];
  };
  style?: StrokeStyleConfig;
}

// Geometric shapes
export interface ShapeLine {
  start: [number, number];
  end: [number, number];
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapeArrow {
  start: [number, number];
  tip: [number, number];
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapeRect {
  cuboid?: {
    half_extents: [number, number];
    origin?: [number, number];
  };
  half_extents?: [number, number];
  origin?: [number, number];
  size?: [number, number];
  border_radius?: number;
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapeEllipse {
  radii: [number, number];
  center?: [number, number];
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapeCubbez {
  start?: [number, number];
  cp1?: [number, number];
  cp2?: [number, number];
  end?: [number, number];
  p0?: [number, number];
  p1?: [number, number];
  p2?: [number, number];
  p3?: [number, number];
  points?: [number, number][];
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapeQuadbez {
  start?: [number, number];
  cp?: [number, number];
  end?: [number, number];
  p0?: [number, number];
  p1?: [number, number];
  p2?: [number, number];
  points?: [number, number][];
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapePolyLine {
  start?: [number, number];
  path?: [number, number][];
  points?: [number, number][];
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapePolygon {
  start?: [number, number];
  path?: [number, number][];
  points?: [number, number][];
  affine?: AffineTransform;
  transform?: AffineTransform;
}

export interface ShapeStroke {
  shape: {
    line?: ShapeLine;
    arrow?: ShapeArrow;
    rect?: ShapeRect;
    rectangle?: ShapeRect;
    ellipse?: ShapeEllipse;
    cubbez?: ShapeCubbez;
    cubic_bezier?: ShapeCubbez;
    quadbez?: ShapeQuadbez;
    quadratic_bezier?: ShapeQuadbez;
    polyline?: ShapePolyLine;
    poly_line?: ShapePolyLine;
    polygon?: ShapePolygon;
  };
  style?: StrokeStyleConfig;
  transform?: AffineTransform;
  affine?: AffineTransform;
}

export interface TextStyle {
  font_size?: number;
  color?: RnoteColor;
  font_family?: string;
  font_weight?: string | number;
  font_style?: string;
  line_height?: number;
}

export interface TextStroke {
  text: string;
  text_style?: TextStyle;
  transform?: AffineTransform;
  affine?: AffineTransform;
}

export interface BitmapImageData {
  data?: string | number[] | Uint8Array;
  format?: string;
}

export interface BitmapImage {
  image?: BitmapImageData | { data?: string | number[] | Uint8Array; rectangle?: ShapeRect };
  rectangle?: ShapeRect;
  data?: string | number[] | Uint8Array;
  pixel_width?: number;
  pixel_height?: number;
  half_extents?: [number, number];
  transform?: AffineTransform;
  affine?: AffineTransform;
}

export interface VectorImage {
  svg_data: string;
  intrinsic_size?: [number, number];
  rectangle?: ShapeRect;
  transform?: AffineTransform;
  affine?: AffineTransform;
}

export interface StrokeComponentValue {
  brushstroke?: BrushStroke;
  shapestroke?: ShapeStroke;
  textstroke?: TextStroke;
  bitmapimage?: BitmapImage;
  vectorimage?: VectorImage;
}

export interface StrokeComponent {
  value?: StrokeComponentValue | null;
  brushstroke?: BrushStroke;
  shapestroke?: ShapeStroke;
  textstroke?: TextStroke;
  bitmapimage?: BitmapImage;
  vectorimage?: VectorImage;
}

// Document background & layout definitions
export interface DocumentBackground {
  color?: RnoteColor;
  pattern?: "none" | "dots" | "grid" | "lines" | string;
  pattern_size?: number;
  pattern_color?: RnoteColor;
}

export interface DocumentFormat {
  continuous?: boolean;
  border?: boolean;
  width?: number;
  height?: number;
  dpi?: number;
  orientation?: string;
  border_color?: RnoteColor;
  show_borders?: boolean;
  show_origin_indicator?: boolean;
}

export interface DocumentSnapshot {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  format?: DocumentFormat;
  background?: DocumentBackground;
  config?: {
    format?: DocumentFormat;
    background?: DocumentBackground;
    layout?: unknown;
  };
}

export interface EngineSnapshot {
  document?: DocumentSnapshot;
  stroke_components?: unknown;
}

export interface ParsedRnoteDocument {
  version: string;
  components: StrokeComponent[];
  background?: DocumentBackground;
  format?: DocumentFormat;
  documentBounds?: { x: number; y: number; width: number; height: number };
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type BackgroundMode = "adaptive" | "rnote-native" | "transparent" | "light" | "dark";

export interface RenderOptions {
  backgroundMode?: BackgroundMode;
  isDarkTheme?: boolean;
  padding?: number;
  strokeWidthScale?: number;
}

export interface RnotePluginSettings {
  backgroundMode: BackgroundMode;
  defaultZoom: number;
  enablePanZoom: boolean;
  cacheCapacity: number;
  showPattern: boolean;
  strokeWidthScale: number;
}

export const DEFAULT_SETTINGS: RnotePluginSettings = {
  backgroundMode: "rnote-native",
  defaultZoom: 1.0,
  enablePanZoom: true,
  cacheCapacity: 100,
  showPattern: true,
  strokeWidthScale: 0.45,
};
