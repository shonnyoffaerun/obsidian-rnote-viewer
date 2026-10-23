# Obsidian Rnote Viewer Plugin

A blazingly fast, lightweight, read-only [Obsidian](https://obsidian.md) plugin written in TypeScript to view and embed `.rnote` vector note files created by the [Rnote](https://rnote.flxzt.net/) vector note-taking app.

---

## 🚀 Features

- **Dual Viewing Modes**:
  - **Dedicated Viewer Tab (`FileView`)**: Opening any `.rnote` file opens an interactive vector canvas tab with Pan & Zoom.
  - **Markdown Embeds**: Embed drawings inline using standard Obsidian wikilinks: `![[drawing.rnote]]` or with custom sizing: `![[drawing.rnote|400]]`.
- **Pressure Dynamics**:
  - Brush strokes are rendered with variable width based on pressure along the path normal vectors, producing smooth, crisp calligraphy outlines.
- **Full Geometric Primitive Support**:
  - Geometric shapes: lines, arrows (crisp vector arrowheads), rectangles (with half-extents), ellipses, cubic & quadratic Bézier curves, polylines, and polygons.
  - Multi-line text strokes with font styling.
  - Embedded bitmap images (PNG, JPEG, WebP, raw bytes).
  - Accurate 3x3 affine transform matrix mapping (`matrix(m0, m1, m3, m4, m6, m7)`).
- **Ultra-Fast & Memory Efficient**:
  - High-speed GZIP decompression via zero-dependency `fflate` and native `DecompressionStream`.
  - Single-pass traversal calculating minimal enclosing `viewBox` with boundary padding.
  - **In-Memory LRU Cache**: Rendered SVGs are cached in memory keyed by `${file.path}:${file.stat.mtime}` so re-opening notes or scrolling never re-decompresses or re-parses.
- **Pan & Zoom Support**:
  - Mouse wheel zoom centered on cursor.
  - Mouse drag to pan with interactive grab cursor.
  - Touchpad & touch pinch-to-zoom for tablet and mobile Obsidian.
  - Floating toolbar with zoom percentage badge, Zoom In, Zoom Out, and "Zoom to Fit".
- **Theme & Paper Pattern Adaptation**:
  - Seamless dark and light theme adaptation.
  - Paper pattern support: renders Rnote's native background patterns (grid, dots, lines).
  - Background options: `Adaptive`, `Rnote Native`, `Transparent`, `Always Light`, `Always Dark`.
- **Open in Default App**:
  - Header action button in the viewer and embed header allowing 1-click opening in the native Rnote app for quick editing.

---

## 📦 Project Structure

```text
obsidian-rnote-viewer/
├── manifest.json         # Obsidian plugin manifest
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript compiler configuration (strict mode)
├── esbuild.config.mjs    # Fast bundler config
├── styles.css            # Styles for pan/zoom canvas, embeds, toolbar
├── src/
│   ├── main.ts           # Plugin lifecycle, view registration, embed processor, settings
│   ├── types.ts          # TypeScript interfaces for .rnote format & plugin
│   ├── parser.ts         # Fast GZIP decompression and JSON extraction
│   ├── renderer.ts       # High-speed SVG builder (strokes, shapes, text, images, matrices)
│   ├── view.ts           # Obsidian FileView implementation with Pan/Zoom
│   └── cache.ts          # In-memory LRU cache
└── test/
    └── rnote.test.ts     # Automated unit tests
```

---

## 🛠️ Development & Building

### 1. Build Production Bundle
```bash
npm run build
```
This generates the standalone, minified `main.js` (under 50 KB).

### 2. Type Checking
```bash
npm run typecheck
```

### 3. Run Automated Tests
```bash
npm test
```

---

## 📥 Installation in Obsidian

1. Copy `manifest.json`, `main.js`, and `styles.css` to your Obsidian vault's plugin directory:
   `<Vault>/.obsidian/plugins/obsidian-rnote-viewer/`
2. Open Obsidian, go to **Settings -> Community Plugins**, and enable **Rnote Viewer**.
3. Drag any `.rnote` file into your vault and open it, or type `![[your-drawing.rnote]]` in any Markdown file!

---

## 📄 License
MIT License.
