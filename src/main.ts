import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { LruCache, CachedSvg } from "./cache";
import { parseRnoteFile } from "./parser";
import { renderRnoteToSvg } from "./renderer";
import {
  BackgroundMode,
  DEFAULT_SETTINGS,
  RnotePluginSettings,
} from "./types";
import { RnoteView, VIEW_TYPE_RNOTE } from "./view";

export default class RnotePlugin extends Plugin {
  settings: RnotePluginSettings = DEFAULT_SETTINGS;
  cache!: LruCache<string, CachedSvg>;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize LRU in-memory cache
    this.cache = new LruCache<string, CachedSvg>(this.settings.cacheCapacity);

    // Register dedicated FileView for .rnote files
    this.registerView(
      VIEW_TYPE_RNOTE,
      (leaf: WorkspaceLeaf) => new RnoteView(leaf, this)
    );

    // Associate .rnote extension with the custom view
    this.registerExtensions(["rnote"], VIEW_TYPE_RNOTE);

    // Register Markdown Post-Processor for embeds like ![[drawing.rnote]]
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      await this.processMarkdownEmbeds(el, ctx.sourcePath);
    });

    // Register codeblock processor ```rnote drawing.rnote```
    this.registerMarkdownCodeBlockProcessor("rnote", async (source, el, ctx) => {
      await this.processCodeBlock(source, el, ctx.sourcePath);
    });

    // Add plugin settings tab
    this.addSettingTab(new RnoteSettingTab(this.app, this));
  }

  onunload(): void {
    // Clear LRU cache on unload to free memory
    this.cache.clear();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.cache) {
      this.cache.setCapacity(this.settings.cacheCapacity);
    }
  }

  /**
   * Resolves a file linkpath to a TFile in the vault, with fallbacks if metadataCache hasn't indexed it.
   */
  resolveRnoteFile(linkPath: string, sourcePath: string): TFile | null {
    // 1. Metadata cache resolution
    const fromCache = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    if (fromCache instanceof TFile) return fromCache;

    // 2. Direct vault path
    const byPath = this.app.vault.getAbstractFileByPath(linkPath);
    if (byPath instanceof TFile) return byPath;

    // 3. Normalized vault traversal fallback
    const cleanTarget = linkPath.split("/").pop()?.trim().toLowerCase();
    const allFiles = this.app.vault.getFiles();
    const found = allFiles.find((f) => {
      if (f.extension !== "rnote") return false;
      const fPath = f.path.toLowerCase();
      const fName = f.name.toLowerCase();
      return (
        fPath === linkPath.toLowerCase() ||
        fName === cleanTarget ||
        f.basename.toLowerCase() === cleanTarget
      );
    });

    return found ?? null;
  }

  /**
   * Processes all .rnote embeds found inside a rendered Markdown document.
   */
  private async processMarkdownEmbeds(el: HTMLElement, sourcePath: string): Promise<void> {
    const candidates = Array.from(
      el.querySelectorAll<HTMLElement>(
        '.internal-embed, .file-embed, [src*=".rnote"], [data-src*=".rnote"], [data-href*=".rnote"], [alt*=".rnote"], img[src*=".rnote"]'
      )
    );

    for (const target of candidates) {
      // Avoid re-processing already converted embeds
      if (target.hasClass("rnote-embed-wrapper") || target.closest(".rnote-embed-wrapper")) {
        continue;
      }

      const rawSrc =
        target.getAttribute("src") ||
        target.getAttribute("data-src") ||
        target.getAttribute("data-href") ||
        target.getAttribute("alt") ||
        "";

      if (!rawSrc.toLowerCase().includes(".rnote")) continue;

      let linkPath = rawSrc.trim();
      let customWidth: string | null = null;

      // Handle Obsidian wikilink alias/width format: "filename.rnote|400" or "filename.rnote|400x300"
      if (linkPath.includes("|")) {
        const parts = linkPath.split("|");
        linkPath = parts[0].trim();
        const widthCandidate = parts[1].trim();
        if (/^\d+(x\d+)?$/.test(widthCandidate)) {
          customWidth = widthCandidate.includes("x")
            ? widthCandidate.split("x")[0]
            : widthCandidate;
        }
      }

      const alt = target.getAttribute("alt")?.trim();
      if (!customWidth && alt && /^\d+$/.test(alt)) {
        customWidth = alt;
      }

      const file = this.resolveRnoteFile(linkPath, sourcePath);
      if (!(file instanceof TFile)) continue;

      await this.renderEmbedElement(target, file, customWidth, false);
    }
  }

  /**
   * Processes ```rnote code blocks
   */
  private async processCodeBlock(source: string, containerEl: HTMLElement, sourcePath: string): Promise<void> {
    const trimmed = source.trim();
    if (!trimmed) return;

    const firstLine = trimmed.split("\n")[0].trim();
    let linkPath = firstLine;
    let customWidth: string | null = null;

    if (linkPath.includes("|")) {
      const parts = linkPath.split("|");
      linkPath = parts[0].trim();
      customWidth = parts[1].trim();
    }

    const file = this.resolveRnoteFile(linkPath, sourcePath);
    if (!file) {
      containerEl.empty();
      const errBox = containerEl.createDiv({ cls: "rnote-error-container" });
      errBox.createDiv({ cls: "rnote-error-title", text: `Rnote drawing not found: ${linkPath}` });
      return;
    }

    await this.renderEmbedElement(containerEl, file, customWidth, true);
  }

  /**
   * Renders the vector drawing directly inline inside Markdown notes.
   */
  private async renderEmbedElement(
    targetEl: HTMLElement,
    file: TFile,
    customWidth: string | null,
    isCodeBlock: boolean
  ): Promise<void> {
    const scale = this.settings.strokeWidthScale ?? 0.45;
    const cacheKey = `${file.path}:${file.stat.mtime}:${this.settings.backgroundMode}:${scale}`;
    let cached = this.cache.get(cacheKey);

    const isDark = document.body.classList.contains("theme-dark");

    try {
      if (!cached) {
        const binary = await this.app.vault.readBinary(file);
        const parsed = await parseRnoteFile(binary);
        const rendered = renderRnoteToSvg(parsed, {
          backgroundMode: this.settings.backgroundMode,
          isDarkTheme: isDark,
          strokeWidthScale: scale,
        });

        cached = {
          svg: rendered.svg,
          viewBox: rendered.viewBox,
          width: rendered.width,
          height: rendered.height,
        };
        this.cache.set(cacheKey, cached);
      }

      // Create replacement embed wrapper
      const wrapper = isCodeBlock ? targetEl : createDiv({ cls: "rnote-embed-wrapper" });
      if (isCodeBlock) {
        wrapper.empty();
        wrapper.addClass("rnote-embed-wrapper");
      }
      if (customWidth) {
        wrapper.style.maxWidth = `${customWidth}px`;
      }

      // Header bar
      const header = wrapper.createDiv({ cls: "rnote-embed-header" });
      const titleSpan = header.createSpan({ cls: "rnote-embed-title" });
      titleSpan.innerHTML = `✏️ <span>${file.basename}</span>`;
      titleSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        this.app.workspace.getLeaf(false).openFile(file);
      });

      const openExternalBtn = header.createSpan({
        cls: "rnote-embed-action",
        text: "↗ Open in App",
        attr: { "aria-label": "Open in default Rnote app" },
      });
      openExternalBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const desktopApp = this.app as unknown as { openWithDefaultApp?: (path: string) => void };
        if (typeof desktopApp.openWithDefaultApp === "function") {
          desktopApp.openWithDefaultApp(file.path);
        }
      });

      // SVG Container
      const svgContainer = wrapper.createDiv({ cls: "rnote-embed-svg-container" });
      svgContainer.innerHTML = cached.svg;
      svgContainer.addEventListener("click", () => {
        this.app.workspace.getLeaf(false).openFile(file);
      });

      if (!isCodeBlock) {
        targetEl.replaceWith(wrapper);
      }
    } catch (err) {
      console.error("[Rnote Viewer]", err);
      const errBox = isCodeBlock ? targetEl : createDiv({ cls: "rnote-error-container" });
      if (isCodeBlock) errBox.empty();
      errBox.createDiv({ cls: "rnote-error-title", text: `Error loading ${file.basename}.rnote` });
      errBox.createDiv({
        cls: "rnote-error-message",
        text: err instanceof Error ? err.message : String(err),
      });
      if (!isCodeBlock) {
        targetEl.replaceWith(errBox);
      }
    }
  }
}

class RnoteSettingTab extends PluginSettingTab {
  plugin: RnotePlugin;

  constructor(app: App, plugin: RnotePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Rnote Viewer Settings" });

    new Setting(containerEl)
      .setName("Background Mode")
      .setDesc("Choose how the canvas background is rendered for .rnote files")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("adaptive", "Adaptive (Match Obsidian Theme)")
          .addOption("rnote-native", "Rnote Native (Document colors & paper pattern)")
          .addOption("transparent", "Transparent")
          .addOption("light", "Always Light")
          .addOption("dark", "Always Dark")
          .setValue(this.plugin.settings.backgroundMode)
          .onChange(async (value) => {
            this.plugin.settings.backgroundMode = value as BackgroundMode;
            this.plugin.cache.clear();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pen Stroke Thickness")
      .setDesc("Calibrates stroke width so handwriting is fine, crisp, and authentic")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("0.45", "Fine (0.45x - Recommended for handwriting)")
          .addOption("0.30", "Ultra-Fine (0.30x - Extra thin)")
          .addOption("0.70", "Medium (0.70x)")
          .addOption("1.00", "Original (1.00x - Native Rnote width)")
          .setValue(String(this.plugin.settings.strokeWidthScale ?? 0.45))
          .onChange(async (value) => {
            this.plugin.settings.strokeWidthScale = parseFloat(value);
            this.plugin.cache.clear();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Cache Capacity")
      .setDesc("Maximum number of rendered SVG drawings to keep in memory for instant loading")
      .addSlider((slider) =>
        slider
          .setLimits(20, 500, 10)
          .setValue(this.plugin.settings.cacheCapacity)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.cacheCapacity = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Clear Render Cache")
      .setDesc("Evict all in-memory SVG caches to reclaim memory")
      .addButton((btn) =>
        btn.setButtonText("Clear Cache").onClick(() => {
          this.plugin.cache.clear();
          btn.setButtonText("Cleared!");
          setTimeout(() => btn.setButtonText("Clear Cache"), 2000);
        })
      );
  }
}
