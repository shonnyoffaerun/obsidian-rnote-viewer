import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "fflate";
import { LruCache } from "../src/cache.ts";
import { parseRnoteFile, isGzipBuffer } from "../src/parser.ts";
import {
  renderRnoteToSvg,
  renderBrushStroke,
  renderShapeStroke,
  renderTextStroke,
  renderBitmapImage,
  renderVectorImage,
  applyTransform,
  transformMatrixToSvg,
  normalizeTransform,
  BoundingBoxTracker,
  colorToCss,
  extractStyle,
} from "../src/renderer.ts";
import { ParsedRnoteDocument } from "../src/types.ts";

describe("LRU Cache", () => {
  test("caches and evicts items according to capacity", () => {
    const cache = new LruCache<string, string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    assert.equal(cache.size(), 3);
    assert.equal(cache.get("a"), "1");

    cache.set("d", "4");
    assert.equal(cache.has("b"), false);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("c"), true);
    assert.equal(cache.has("d"), true);
  });

  test("resizing capacity evicts excess items", () => {
    const cache = new LruCache<string, number>(5);
    for (let i = 1; i <= 5; i++) {
      cache.set(`k${i}`, i);
    }
    assert.equal(cache.size(), 5);

    cache.setCapacity(2);
    assert.equal(cache.size(), 2);
    assert.equal(cache.has("k4"), true);
    assert.equal(cache.has("k5"), true);
  });
});

describe("Parser & Real Rnote Formats", () => {
  test("detects GZIP header magic bytes", () => {
    assert.equal(isGzipBuffer(new Uint8Array([0x1f, 0x8b, 0x08])), true);
    assert.equal(isGzipBuffer(new Uint8Array([0x00, 0x00])), false);
  });

  test("parses real Rnote v0.15 format with root engine_snapshot and SlotMap tuples", async () => {
    const realRnoteData = {
      engine_snapshot: {
        document: {
          x: 0,
          y: 0,
          width: 800,
          height: 1100,
          config: {
            background: {
              color: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
              pattern: "dots",
              pattern_size: 24,
            },
          },
        },
        stroke_components: [
          // SlotMap tuple [key, stroke]
          [
            "1v0",
            {
              brushstroke: {
                path: {
                  start: { pos: [50, 100], pressure: 0.7 },
                  segments: [
                    { quadbezto: { cp: [75, 120], end: { pos: [100, 150], pressure: 0.9 } } },
                  ],
                },
                style: {
                  smooth: {
                    stroke_width: 3.5,
                    stroke_color: { r: 0.1, g: 0.2, b: 0.8, a: 1.0 },
                  },
                },
              },
            },
          ],
        ],
      },
    };

    const compressed = gzipSync(new TextEncoder().encode(JSON.stringify(realRnoteData)));
    const doc = await parseRnoteFile(compressed);

    assert.equal(doc.components.length, 1);
    assert.ok(doc.components[0].brushstroke);
    assert.equal(doc.background?.pattern, "dots");
    assert.equal(doc.documentBounds?.width, 800);
    assert.equal(doc.documentBounds?.height, 1100);
  });

  test("parses format with value wrapper and null value skipping", async () => {
    const data = {
      engine_snapshot: {
        stroke_components: [
          { value: null }, // deleted stroke in Rnote snapshot
          {
            value: {
              textstroke: {
                text: "Test Note",
                text_style: { font_size: 20 },
              },
            },
          },
        ],
      },
    };

    const compressed = gzipSync(new TextEncoder().encode(JSON.stringify(data)));
    const doc = await parseRnoteFile(compressed);
    assert.equal(doc.components.length, 1);
    assert.ok(doc.components[0].value?.textstroke);
  });
});

describe("Renderer: Nested Styles & Normalization", () => {
  test("extracts style from smooth/rough/textured variants", () => {
    const smoothStyle = extractStyle({
      smooth: {
        stroke_width: 4.5,
        stroke_color: { r: 1, g: 0, b: 0 },
        fill_color: { r: 0, g: 1, b: 0 },
      },
    });
    assert.equal(smoothStyle.strokeWidth, 4.5);
    assert.equal(smoothStyle.strokeColor, "rgb(255, 0, 0)");
    assert.equal(smoothStyle.fillColor, "rgb(0, 255, 0)");
  });

  test("normalizes 6-element and 9-element affine transforms", () => {
    // 6 elements: [a, b, c, d, tx, ty]
    const norm6 = normalizeTransform([2, 0, 0, 3, 50, 60]);
    assert.deepEqual(norm6, [2, 0, 0, 3, 50, 60]);

    // 9 elements: [m0, m1, m2, m3, m4, m5, m6, m7, m8]
    const norm9 = normalizeTransform([2, 0, 0, 0, 3, 0, 50, 60, 1]);
    assert.deepEqual(norm9, [2, 0, 0, 3, 50, 60]);

    // SVG string
    assert.equal(transformMatrixToSvg([2, 0, 0, 3, 50, 60]), "matrix(2,0,0,3,50,60)");
  });

  test("renders quadbezto brush segments with smooth curve interpolation", () => {
    const tracker = new BoundingBoxTracker();
    const svg = renderBrushStroke(
      {
        path: {
          start: { pos: [0, 0], pressure: 0.5 },
          segments: [
            { quadbezto: { cp: [50, 100], end: { pos: [100, 0], pressure: 0.8 } } },
          ],
        },
        style: {
          smooth: {
            stroke_width: 3.0,
            stroke_color: "#333333",
          },
        },
      },
      tracker
    );

    assert.ok(svg?.startsWith("<path d="));
    assert.ok(svg?.includes(" Q 50 100, 100 0"));
    assert.ok(svg?.includes('stroke="#333333"'));
    assert.ok(svg?.includes('stroke-linecap="round"'));
    assert.ok(svg?.includes('stroke-linejoin="round"'));
    assert.ok(tracker.hasBounds());
    const box = tracker.getBox(0);
    assert.ok(box.width >= 100);
  });

  test("renders polyline and polygon with start and path vectors", () => {
    const tracker = new BoundingBoxTracker();
    const polylineSvg = renderShapeStroke(
      {
        shape: {
          polyline: {
            start: [10, 10],
            path: [
              [50, 50],
              [90, 10],
            ],
          },
        },
        style: { smooth: { stroke_width: 2.0, stroke_color: "#000" } },
      },
      tracker
    );

    assert.ok(polylineSvg?.includes("<polyline points=\"10,10 50,50 90,10\""));
  });

  test("renders vectorimage embedded SVG", () => {
    const tracker = new BoundingBoxTracker();
    const vectorSvg = renderVectorImage(
      {
        svg_data: "<svg><circle cx='10' cy='10' r='5'/></svg>",
        intrinsic_size: [100, 100],
        rectangle: {
          cuboid: { half_extents: [50, 50] },
          affine: [1, 0, 0, 1, 200, 200],
        },
      },
      tracker
    );

    assert.ok(vectorSvg?.includes("<image"));
    assert.ok(vectorSvg?.includes("data:image/svg+xml;base64,"));
    assert.ok(vectorSvg?.includes('transform="matrix(1,0,0,1,200,200)"'));
  });

  test("renders complete document using documentBounds if empty strokes", () => {
    const doc: ParsedRnoteDocument = {
      version: "0.15.0",
      components: [],
      documentBounds: { x: 0, y: 0, width: 800, height: 1100 },
      background: { color: { r: 1, g: 1, b: 1 }, pattern: "grid", pattern_size: 20 },
    };

    const rendered = renderRnoteToSvg(doc, { backgroundMode: "rnote-native" });
    assert.ok(rendered.svg.includes('id="rnote-bg-grid"'));
    assert.ok(rendered.width >= 800);
    assert.ok(rendered.height >= 1100);
  });

  test("renders authentic paper sheet with grid pattern and borders", () => {
    const doc: ParsedRnoteDocument = {
      version: "0.15.0",
      components: [
        {
          brushstroke: {
            path: { start: { pos: [100, 200] }, segments: [{ lineto: { end: { pos: [300, 400] } } }] },
            style: { smooth: { stroke_width: 2 } },
          },
        },
      ],
      format: { width: 793.7, height: 1122.5, border_color: { r: 0.5, g: 0.5, b: 0.5 } },
      background: {
        color: { r: 0.98, g: 0.98, b: 0.98 },
        pattern: "grid",
        pattern_size: [18.898, 18.898],
      },
    };

    const native = renderRnoteToSvg(doc, { backgroundMode: "rnote-native" });
    assert.ok(native.svg.includes('class="rnote-paper-sheet"'));
    assert.ok(native.svg.includes('id="rnote-bg-grid"'));
    assert.ok(native.svg.includes('url(#rnote-bg-grid)'));
    assert.equal(native.width, 794 + 48); // 794 rounded + 24px padding on both sides
  });

  test("renders multi-page divider lines when content exceeds single page", () => {
    const doc: ParsedRnoteDocument = {
      version: "0.15.0",
      components: [
        {
          brushstroke: {
            path: { start: { pos: [100, 1500] }, segments: [{ lineto: { end: { pos: [200, 1600] } } }] },
            style: { smooth: { stroke_width: 2 } },
          },
        },
      ],
      format: { width: 793.7, height: 1000 },
      background: { pattern: "lines", pattern_size: 25 },
    };

    const rendered = renderRnoteToSvg(doc, { backgroundMode: "rnote-native" });
    // y=1500 on 1000px height page -> 2 pages total, divider at y=1000
    assert.ok(rendered.svg.includes('stroke-dasharray="6 4"'));
    assert.ok(rendered.svg.includes('y1="1000"'));
  });

  test("adaptive mode preserves pattern in dark mode", () => {
    const doc: ParsedRnoteDocument = {
      version: "0.15.0",
      components: [],
      format: { width: 800, height: 1000 },
      background: { pattern: "dots", pattern_size: [20, 20] },
    };

    const darkAdaptive = renderRnoteToSvg(doc, { backgroundMode: "adaptive", isDarkTheme: true });
    assert.ok(darkAdaptive.svg.includes('id="rnote-bg-dots"'));
    assert.ok(darkAdaptive.svg.includes('url(#rnote-bg-dots)'));
  });

  test("renders linear pressure progression with dynamic width scaling", () => {
    const tracker = new BoundingBoxTracker();
    const svg = renderBrushStroke(
      {
        path: {
          start: { pos: [10, 10], pressure: 0.2 },
          segments: [
            { lineto: { end: { pos: [30, 30], pressure: 0.2 } } },
            { lineto: { end: { pos: [60, 60], pressure: 0.4 } } },
            { lineto: { end: { pos: [90, 90], pressure: 0.4 } } },
          ],
        },
        style: {
          smooth: {
            stroke_width: 3.0,
            stroke_color: "#ffffff",
            pressure_curve: "linear",
          },
        },
      },
      tracker
    );

    // Continuous unbroken path with round join and round cap
    assert.ok(svg?.startsWith("<path d=\"M 10 10 L 30 30 L 60 60 L 90 90\""));
    assert.ok(svg?.includes('stroke-linejoin="round"'));
    assert.ok(svg?.includes('stroke-linecap="round"'));
    // Fine-Ink calibrated thin width
    assert.ok(svg?.includes('stroke-width="0.35"'));
  });
});


