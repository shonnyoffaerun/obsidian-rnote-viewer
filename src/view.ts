import { FileView, WorkspaceLeaf, TFile } from "obsidian";
import { parseRnoteFile } from "./parser";
import { renderRnoteToSvg } from "./renderer";
import { BackgroundMode, ParsedRnoteDocument } from "./types";
import type RnotePlugin from "./main";

export const VIEW_TYPE_RNOTE = "rnote-view";

function fmt(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return Number(n.toFixed(2)).toString();
}

export class RnoteView extends FileView {
  plugin: RnotePlugin;
  private container!: HTMLElement;
  private viewportEl!: HTMLElement;
  private svgEl: SVGSVGElement | null = null;
  private floatingControlsEl!: HTMLElement;
  private zoomBadgeEl!: HTMLElement;

  private parsedDoc: ParsedRnoteDocument | null = null;

  // Base bounding box of content in SVG units
  private baseMinX = 0;
  private baseMinY = 0;
  private baseWidth = 800;
  private baseHeight = 600;

  // Current viewBox visible coordinates
  private currentViewMinX = 0;
  private currentViewMinY = 0;
  private currentViewWidth = 800;
  private currentViewHeight = 600;
  private currentZoom = 1.0;

  // Mouse & Touch interaction state
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMoveTime = 0;

  // Kinetic inertia / momentum scrolling
  private velocityX = 0;
  private velocityY = 0;
  private momentumAnimId: number | null = null;

  // Touch gesture state (pinch-to-zoom)
  private initialPinchDist = 0;
  private initialPinchZoom = 1.0;

  private currentBackgroundMode: BackgroundMode;
  private currentStrokeWidthScale: number;
  private penThicknessBtn: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private rafPending = false;

  constructor(leaf: WorkspaceLeaf, plugin: RnotePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentBackgroundMode = plugin.settings.backgroundMode;
    this.currentStrokeWidthScale = plugin.settings.strokeWidthScale ?? 0.45;
  }

  getViewType(): string {
    return VIEW_TYPE_RNOTE;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "Rnote";
  }

  getIcon(): string {
    return "pen-tool";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "rnote";
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl;
    this.container.empty();
    this.container.addClass("rnote-view-container");

    this.addAction("external-link", "Open in default app (Rnote)", () => {
      if (this.file) {
        const desktopApp = this.app as unknown as { openWithDefaultApp?: (path: string) => void };
        if (typeof desktopApp.openWithDefaultApp === "function") {
          desktopApp.openWithDefaultApp(this.file.path);
        }
      }
    });

    this.addAction("stretch-horizontal", "Fit to width", () => {
      this.fitToWidth();
    });

    this.addAction("maximize", "Fit whole page", () => {
      this.zoomToFit();
    });

    this.addAction("palette", "Toggle background mode", () => {
      this.cycleBackgroundMode();
    });

    this.buildUi();
    this.setupEvents();

    if (this.file) {
      await this.onLoadFile(this.file);
    }
  }

  private buildUi(): void {
    this.container.empty();

    // Viewport fills tab
    this.viewportEl = this.container.createDiv({ cls: "rnote-viewport" });

    // Floating toolbar
    this.floatingControlsEl = this.container.createDiv({ cls: "rnote-floating-controls" });

    const zoomOutBtn = this.floatingControlsEl.createEl("button", {
      cls: "rnote-control-btn",
      text: "−",
      attr: { "aria-label": "Zoom out" },
    });
    zoomOutBtn.addEventListener("click", () => this.zoomByFactor(0.8));

    this.zoomBadgeEl = this.floatingControlsEl.createSpan({
      cls: "rnote-zoom-badge",
      text: "100%",
      attr: { "aria-label": "Click to reset to 100% (1:1)" },
    });
    this.zoomBadgeEl.addEventListener("click", () => this.resetTo100());

    const zoomInBtn = this.floatingControlsEl.createEl("button", {
      cls: "rnote-control-btn",
      text: "+",
      attr: { "aria-label": "Zoom in" },
    });
    zoomInBtn.addEventListener("click", () => this.zoomByFactor(1.25));

    this.floatingControlsEl.createDiv({ cls: "rnote-control-separator" });

    const widthBtn = this.floatingControlsEl.createEl("button", {
      cls: "rnote-control-btn",
      text: "Width",
      attr: { "aria-label": "Fit to width (reading mode)" },
    });
    widthBtn.addEventListener("click", () => this.fitToWidth());

    const fitBtn = this.floatingControlsEl.createEl("button", {
      cls: "rnote-control-btn",
      text: "Page",
      attr: { "aria-label": "Fit whole document" },
    });
    fitBtn.addEventListener("click", () => this.zoomToFit());

    this.floatingControlsEl.createDiv({ cls: "rnote-control-separator" });

    this.penThicknessBtn = this.floatingControlsEl.createEl("button", {
      cls: "rnote-control-btn rnote-pen-btn",
      text: this.getPenScaleLabel(this.currentStrokeWidthScale),
      attr: { "aria-label": "Toggle pen stroke thickness (Fine / Ultra-thin / Medium / Original)" },
    });
    this.penThicknessBtn.addEventListener("click", () => this.cycleStrokeWidthScale());
  }

  private setupEvents(): void {
    // 1. Mouse Dragging & Inertia Pan
    this.viewportEl.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0 && e.button !== 1) return; // Left or Middle click
      if ((e.target as HTMLElement).closest(".rnote-floating-controls")) return;

      this.stopMomentum();
      this.isDragging = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.lastMoveTime = performance.now();
      this.velocityX = 0;
      this.velocityY = 0;
      this.viewportEl.addClass("is-dragging");
    });

    window.addEventListener("mousemove", (e: MouseEvent) => {
      if (!this.isDragging || !this.svgEl) return;
      const rect = this.viewportEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const now = performance.now();
      const dt = Math.max(1, now - this.lastMoveTime);
      this.lastMoveTime = now;

      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      // Convert screen pixel delta to SVG coordinates
      const svgDeltaX = dx * (this.currentViewWidth / rect.width);
      const svgDeltaY = dy * (this.currentViewHeight / rect.height);

      this.currentViewMinX -= svgDeltaX;
      this.currentViewMinY -= svgDeltaY;
      this.scheduleApplyViewBox();

      // Velocity in SVG units per second with exponential moving average
      const instVx = (svgDeltaX / dt) * 1000;
      const instVy = (svgDeltaY / dt) * 1000;
      this.velocityX = this.velocityX * 0.3 + instVx * 0.7;
      this.velocityY = this.velocityY * 0.3 + instVy * 0.7;
    });

    const stopDrag = () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.viewportEl.removeClass("is-dragging");

        // If pointer was held stationary before release, cancel momentum
        if (performance.now() - this.lastMoveTime > 100) {
          this.velocityX = 0;
          this.velocityY = 0;
        } else {
          this.startMomentum();
        }
      }
    };
    window.addEventListener("mouseup", stopDrag);

    // 2. Mouse Wheel: Scroll by default, Zoom with Ctrl/Meta (standard desktop convention)
    this.viewportEl.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        this.stopMomentum();

        // Ctrl + Wheel or Pinch Trackpad -> Zoom centered at cursor
        if (e.ctrlKey || e.metaKey) {
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          this.zoomAtPoint(factor, e.clientX, e.clientY);
          return;
        }

        // Regular Wheel -> Smooth scroll in SVG coordinates
        const rect = this.viewportEl.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const scaleX = this.currentViewWidth / rect.width;
        const scaleY = this.currentViewHeight / rect.height;

        // Shift key allows horizontal scrolling
        const deltaX = (e.shiftKey ? e.deltaY : e.deltaX) * scaleX;
        const deltaY = (e.shiftKey ? 0 : e.deltaY) * scaleY;

        this.currentViewMinX += deltaX;
        this.currentViewMinY += deltaY;
        this.applyViewBox();
      },
      { passive: false }
    );

    // 3. Touch Support (1 finger swipe with momentum, 2 finger pinch-to-zoom)
    this.viewportEl.addEventListener("touchstart", (e: TouchEvent) => {
      this.stopMomentum();
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.lastMouseX = e.touches[0].clientX;
        this.lastMouseY = e.touches[0].clientY;
        this.lastMoveTime = performance.now();
        this.velocityX = 0;
        this.velocityY = 0;
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        this.initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this.initialPinchZoom = this.currentZoom;
      }
    });

    this.viewportEl.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (e.cancelable) e.preventDefault();
        if (e.touches.length === 1 && this.isDragging && this.svgEl) {
          const rect = this.viewportEl.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;

          const now = performance.now();
          const dt = Math.max(1, now - this.lastMoveTime);
          this.lastMoveTime = now;

          const dx = e.touches[0].clientX - this.lastMouseX;
          const dy = e.touches[0].clientY - this.lastMouseY;
          this.lastMouseX = e.touches[0].clientX;
          this.lastMouseY = e.touches[0].clientY;

          const svgDeltaX = dx * (this.currentViewWidth / rect.width);
          const svgDeltaY = dy * (this.currentViewHeight / rect.height);

          this.currentViewMinX -= svgDeltaX;
          this.currentViewMinY -= svgDeltaY;
          this.scheduleApplyViewBox();

          const instVx = (svgDeltaX / dt) * 1000;
          const instVy = (svgDeltaY / dt) * 1000;
          this.velocityX = this.velocityX * 0.3 + instVx * 0.7;
          this.velocityY = this.velocityY * 0.3 + instVy * 0.7;
        } else if (e.touches.length === 2 && this.initialPinchDist > 0) {
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const factor = dist / this.initialPinchDist;
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          this.zoomAtPoint(factor, midX, midY);
          this.initialPinchDist = dist;
        }
      },
      { passive: false }
    );

    this.viewportEl.addEventListener("touchend", () => {
      if (this.isDragging) {
        this.isDragging = false;
        if (performance.now() - this.lastMoveTime <= 100) {
          this.startMomentum();
        }
      }
      this.initialPinchDist = 0;
    });

    // 4. Double-click toggles between Fit to Width and Fit Whole Page
    this.viewportEl.addEventListener("dblclick", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".rnote-floating-controls")) return;
      const isWidthFitted = Math.abs(this.currentViewWidth - this.baseWidth * 1.08) < 50;
      if (isWidthFitted) {
        this.zoomToFit();
      } else {
        this.fitToWidth();
      }
    });

    // 5. Auto-adjust on window resize
    this.resizeObserver = new ResizeObserver(() => {
      if (this.currentZoom === 1.0) {
        this.fitToWidth();
      }
    });
    this.resizeObserver.observe(this.viewportEl);
  }

  /**
   * Starts smooth inertial physics decay loop (smartphone-like flick momentum).
   */
  private startMomentum(): void {
    this.stopMomentum();

    const speed = Math.hypot(this.velocityX, this.velocityY);
    if (speed < 40) return;

    // Cap excessive flick speeds
    const maxSpeed = 7000;
    if (speed > maxSpeed) {
      this.velocityX *= maxSpeed / speed;
      this.velocityY *= maxSpeed / speed;
    }

    let lastTime = performance.now();
    const friction = 0.93; // Standard mobile touch deceleration factor

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      this.currentViewMinX -= this.velocityX * dt;
      this.currentViewMinY -= this.velocityY * dt;

      // Friction damping
      const decay = Math.pow(friction, dt * 60);
      this.velocityX *= decay;
      this.velocityY *= decay;

      this.applyViewBox();

      if (Math.hypot(this.velocityX, this.velocityY) > 15) {
        this.momentumAnimId = window.requestAnimationFrame(step);
      } else {
        this.stopMomentum();
      }
    };

    this.momentumAnimId = window.requestAnimationFrame(step);
  }

  private stopMomentum(): void {
    if (this.momentumAnimId !== null) {
      window.cancelAnimationFrame(this.momentumAnimId);
      this.momentumAnimId = null;
    }
    this.velocityX = 0;
    this.velocityY = 0;
  }

  async onLoadFile(file: TFile): Promise<void> {
    if (!file) return;

    if (!this.viewportEl) {
      this.container = this.contentEl;
      this.container.empty();
      this.container.addClass("rnote-view-container");
      this.buildUi();
      this.setupEvents();
    }

    try {
      const cacheKey = `${file.path}:${file.stat.mtime}:${this.currentBackgroundMode}:${this.currentStrokeWidthScale}`;
      let cached = this.plugin.cache.get(cacheKey);

      if (!cached) {
        const binary = await this.app.vault.readBinary(file);
        this.parsedDoc = await parseRnoteFile(binary);
        const isDark = document.body.classList.contains("theme-dark");

        const rendered = renderRnoteToSvg(this.parsedDoc, {
          backgroundMode: this.currentBackgroundMode,
          isDarkTheme: isDark,
          strokeWidthScale: this.currentStrokeWidthScale,
        });

        cached = {
          svg: rendered.svg,
          viewBox: rendered.viewBox,
          width: rendered.width,
          height: rendered.height,
        };
        this.plugin.cache.set(cacheKey, cached);
      }

      // Parse base bounding box coordinates from viewBox
      const parts = cached.viewBox.split(" ").map(Number);
      this.baseMinX = parts[0] || 0;
      this.baseMinY = parts[1] || 0;
      this.baseWidth = Math.max(1, parts[2] || cached.width || 800);
      this.baseHeight = Math.max(1, parts[3] || cached.height || 600);

      const prevViewBox = this.svgEl ? this.svgEl.getAttribute("viewBox") : null;
      this.viewportEl.empty();
      const parser = new DOMParser();
      const parsedDoc = parser.parseFromString(cached.svg, "image/svg+xml");
      const importedSvg = parsedDoc.querySelector("svg");
      if (importedSvg) {
        this.svgEl = this.viewportEl.ownerDocument.importNode(importedSvg, true);
        this.viewportEl.appendChild(this.svgEl);
      } else {
        this.svgEl = null;
      }

      if (prevViewBox && this.svgEl) {
        this.svgEl.setAttribute("viewBox", prevViewBox);
      } else {
        window.requestAnimationFrame(() => {
          this.fitToWidth();
        });
      }
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.stopMomentum();
    if (this.viewportEl) this.viewportEl.empty();
    this.svgEl = null;
    this.parsedDoc = null;
    await super.onUnloadFile(file);
  }

  /**
   * Throttles viewBox DOM updates to monitor refresh rate (60/120Hz)
   * eliminating layout thrashing during continuous drag/swipe gestures.
   */
  private scheduleApplyViewBox(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    window.requestAnimationFrame(() => {
      this.rafPending = false;
      this.applyViewBox();
    });
  }

  /**
   * Applies the current view coordinates to the SVG's viewBox directly,
   * triggering native GPU vector rasterization at razor-sharp resolution.
   */
  private applyViewBox(): void {
    if (this.svgEl) {
      this.svgEl.setAttribute(
        "viewBox",
        `${fmt(this.currentViewMinX)} ${fmt(this.currentViewMinY)} ${fmt(
          this.currentViewWidth
        )} ${fmt(this.currentViewHeight)}`
      );
    }
    if (this.zoomBadgeEl) {
      this.zoomBadgeEl.textContent = `${Math.round(this.currentZoom * 100)}%`;
    }
  }

  /**
   * Fits note to viewport width (optimal reading experience).
   * Aligns document top at window top so reading starts immediately.
   */
  public fitToWidth(): void {
    if (!this.svgEl || this.baseWidth <= 0) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const vpW = Math.max(rect.width, 100);
    const vpH = Math.max(rect.height, 100);

    // Provide comfortable 4% side margins
    const margin = Math.max(16, vpW * 0.04);
    const targetW = this.baseWidth;
    const newWidth = targetW * (vpW / Math.max(50, vpW - margin * 2));
    const newHeight = newWidth * (vpH / vpW);

    this.currentViewWidth = newWidth;
    this.currentViewHeight = newHeight;
    this.currentViewMinX = this.baseMinX - (newWidth - targetW) / 2;
    this.currentViewMinY = this.baseMinY - 16 * (newWidth / vpW);

    this.currentZoom = vpW / newWidth;
    this.applyViewBox();
  }

  /**
   * Fits the full vector content cleanly inside the viewport,
   * adjusting the viewBox aspect ratio to match the viewport dimensions.
   */
  public zoomToFit(): void {
    if (!this.svgEl || this.baseWidth <= 0 || this.baseHeight <= 0) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const vpW = Math.max(rect.width, 100);
    const vpH = Math.max(rect.height, 100);

    const vpAspect = vpW / vpH;
    const contentAspect = this.baseWidth / this.baseHeight;

    const marginFactor = 1.05;
    const fitW = this.baseWidth * marginFactor;
    const fitH = this.baseHeight * marginFactor;
    const fitMinX = this.baseMinX - (fitW - this.baseWidth) / 2;
    const fitMinY = this.baseMinY - (fitH - this.baseHeight) / 2;

    if (vpAspect >= contentAspect) {
      this.currentViewHeight = fitH;
      this.currentViewWidth = fitH * vpAspect;
      this.currentViewMinX = fitMinX - (this.currentViewWidth - fitW) / 2;
      this.currentViewMinY = fitMinY;
    } else {
      this.currentViewWidth = fitW;
      this.currentViewHeight = fitW / vpAspect;
      this.currentViewMinX = fitMinX;
      this.currentViewMinY = fitMinY - (this.currentViewHeight - fitH) / 2;
    }

    this.currentZoom = Math.min(vpW / this.currentViewWidth, vpH / this.currentViewHeight);
    this.applyViewBox();
  }

  /**
   * Zooms in or out centered at specific screen coordinates (clientX, clientY).
   */
  private zoomAtPoint(factor: number, clientX: number, clientY: number): void {
    if (!this.svgEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const cursorRatioX = (clientX - rect.left) / rect.width;
    const cursorRatioY = (clientY - rect.top) / rect.height;

    const svgPointX = this.currentViewMinX + cursorRatioX * this.currentViewWidth;
    const svgPointY = this.currentViewMinY + cursorRatioY * this.currentViewHeight;

    const newZoom = Math.min(50.0, Math.max(0.05, this.currentZoom * factor));
    const zoomChange = this.currentZoom / newZoom;

    const newWidth = this.currentViewWidth * zoomChange;
    const newHeight = this.currentViewHeight * zoomChange;

    this.currentViewMinX = svgPointX - cursorRatioX * newWidth;
    this.currentViewMinY = svgPointY - cursorRatioY * newHeight;
    this.currentViewWidth = newWidth;
    this.currentViewHeight = newHeight;
    this.currentZoom = newZoom;

    this.applyViewBox();
  }

  private zoomByFactor(factor: number): void {
    const rect = this.viewportEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    this.zoomAtPoint(factor, centerX, centerY);
  }

  /**
   * Resets view to 1:1 scale (1 SVG unit = 1 screen pixel).
   */
  public resetTo100(): void {
    if (!this.svgEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const vpW = Math.max(rect.width, 100);
    const vpH = Math.max(rect.height, 100);

    const centerPointX = this.baseMinX + this.baseWidth / 2;
    const centerPointY = this.baseMinY + Math.min(this.baseHeight / 2, vpH / 2);

    this.currentViewWidth = vpW;
    this.currentViewHeight = vpH;
    this.currentViewMinX = centerPointX - vpW / 2;
    this.currentViewMinY = centerPointY - vpH / 2;

    this.currentZoom = 1.0;
    this.applyViewBox();
  }

  public cycleBackgroundMode(): void {
    const modes: BackgroundMode[] = ["rnote-native", "adaptive", "light", "dark", "transparent"];
    const idx = modes.indexOf(this.currentBackgroundMode);
    this.currentBackgroundMode = modes[(idx + 1) % modes.length];

    if (this.file) {
      const cacheKey = `${this.file.path}:${this.file.stat.mtime}:${this.currentBackgroundMode}:${this.currentStrokeWidthScale}`;
      this.plugin.cache.delete(cacheKey);
      void this.onLoadFile(this.file);
    }
  }

  public getPenScaleLabel(scale: number): string {
    if (scale <= 0.32) return "Pen: Ultra";
    if (scale <= 0.50) return "Pen: Fine";
    if (scale <= 0.75) return "Pen: Mid";
    return "Pen: 1.0x";
  }

  public cycleStrokeWidthScale(): void {
    const scales = [0.45, 0.30, 0.70, 1.0];
    const currentIndex = scales.findIndex((s) => Math.abs(s - this.currentStrokeWidthScale) < 0.05);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % scales.length;
    this.currentStrokeWidthScale = scales[nextIndex];

    if (this.penThicknessBtn) {
      this.penThicknessBtn.textContent = this.getPenScaleLabel(this.currentStrokeWidthScale);
    }

    this.plugin.settings.strokeWidthScale = this.currentStrokeWidthScale;
    void this.plugin.saveSettings();

    if (this.file) {
      void this.onLoadFile(this.file);
    }
  }

  private showError(msg: string): void {
    console.error("[Rnote Viewer]", msg);
    if (!this.viewportEl) {
      this.container = this.contentEl;
      this.container.empty();
      this.container.addClass("rnote-view-container");
      this.buildUi();
    }
    this.viewportEl.empty();
    const errorContainer = this.viewportEl.createDiv({ cls: "rnote-error-container" });
    errorContainer.createDiv({ cls: "rnote-error-icon", text: "⚠️" });
    errorContainer.createDiv({ cls: "rnote-error-title", text: "Could not display Rnote file" });
    errorContainer.createDiv({ cls: "rnote-error-message", text: msg });
  }

  async onClose(): Promise<void> {
    this.stopMomentum();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.viewportEl) this.viewportEl.empty();
    this.svgEl = null;
  }
}
