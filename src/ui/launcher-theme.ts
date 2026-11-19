import {
  CssProvider,
  StyleContext,
  type Widget,
  type Window,
} from "@sigmasd/gtk/gtk4";
import type { AppearanceSettings, GlassColor } from "../config.ts";

const palettes: Record<
  GlassColor,
  { start: string; end: string; accent: string }
> = {
  ocean: { start: "25, 46, 55", end: "12, 19, 32", accent: "122, 228, 210" },
  iris: { start: "48, 36, 68", end: "23, 18, 37", accent: "192, 168, 250" },
  ember: { start: "57, 39, 33", end: "31, 20, 22", accent: "246, 183, 138" },
  graphite: { start: "42, 46, 55", end: "19, 23, 31", accent: "183, 202, 224" },
};

function glassCss(settings: AppearanceSettings): string {
  const alpha = (100 - settings.transparency) / 100;
  const { start, end, accent } = palettes[settings.color];
  return `
.dg-themed {
  background-color: transparent;
  background-image: none;
  color: #e7f0f5;
  border-radius: 20px;
}

.dg-themed .dg-frame {
  background-color: transparent;
  background-image: linear-gradient(155deg, rgba(${start}, ${alpha}), rgba(${end}, ${alpha}) 68%);
  border: 1px solid rgba(178, 220, 226, 0.28);
  border-radius: 20px;
  color: #e7f0f5;
}

.dg-themed .dim-label {
  color: #b5c9d3;
  opacity: 1;
}

.dg-themed list.boxed-list {
  background-color: rgba(132, 197, 208, 0.08);
  color: #e7f0f5;
  border: 1px solid rgba(177, 216, 231, 0.13);
}

.dg-themed list.boxed-list > row {
  background-color: transparent;
  border-color: rgba(177, 216, 231, 0.13);
}

.dg-themed list.boxed-list > row:hover {
  background-color: rgba(137, 186, 200, 0.10);
}

.dg-themed entry,
.dg-themed button,
.dg-themed popover contents {
  color: #e7f0f5;
  background-color: rgba(13, 26, 38, 0.65);
  background-image: none;
  border-color: rgba(177, 216, 231, 0.19);
}

.dg-themed button:hover {
  background-color: rgba(141, 207, 206, 0.21);
}

.dg-themed button:disabled {
  color: rgba(206, 227, 237, 0.53);
}

.dg-themed button.suggested-action {
  color: #0b2527;
  background-color: rgba(${accent}, 0.95);
}

.dg-themed button.suggested-action:disabled {
  color: rgba(206, 227, 237, 0.53);
  background-color: rgba(141, 207, 206, 0.15);
}

.dg-themed switch:checked,
.dg-themed scale trough highlight {
  background-color: rgba(${accent}, 0.65);
}

.dg-themed scale trough {
  background-color: rgba(174, 221, 226, 0.16);
}

.dg-themed scale slider {
  background-color: rgba(${accent}, 0.94);
}

.dg-themed headerbar.dg-header {
  background-color: transparent;
  background-image: none;
  box-shadow: none;
  padding: 2px 8px 0;
  min-height: 35px;
}

.dg-themed .dg-header button {
  color: #b3cbd5;
  background-color: transparent;
  box-shadow: none;
}

.dg-themed .dg-header button:hover {
  color: #edfcff;
  background-color: rgba(139, 203, 204, 0.16);
}

.dg-themed headerbar.dg-launcher-header {
  min-height: 47px;
  padding: 7px 10px 5px;
}

.dg-themed.dg-settings-open .dg-launcher-header,
.dg-themed.dg-settings-open .dg-results,
.dg-themed.dg-settings-open .dg-search-message,
.dg-themed.dg-settings-open .dg-footer {
  opacity: 0;
}

.dg-themed .dg-search-field {
  background-color: rgba(5, 13, 23, 0.36);
  border: 1px solid rgba(170, 211, 224, 0.19);
  border-radius: 13px;
  color: rgba(${accent}, 0.85);
  padding: 0 12px;
}

.dg-themed .dg-search-field:focus-within {
  background-color: rgba(10, 23, 33, 0.54);
  border-color: rgba(${accent}, 0.53);
  box-shadow: 0 0 0 2px rgba(${accent}, 0.09);
}

.dg-themed entry.dg-search-entry {
  background: none;
  border: none;
  box-shadow: none;
  outline: none;
  color: #f2f8fb;
  caret-color: rgba(${accent}, 0.94);
  font-size: 17px;
  font-weight: 500;
  min-height: 44px;
  padding: 0;
}

.dg-themed entry.dg-search-entry placeholder {
  color: #9bb3c0;
}

.dg-themed .dg-results {
  background: none;
  color: #e7f0f5;
}

.dg-themed .dg-results row.dg-result {
  background: none;
  border-radius: 11px;
  color: #e7f0f5;
  margin: 2px 0;
}

.dg-themed .dg-results row.dg-result:hover {
  background-color: rgba(137, 186, 200, 0.10);
}

.dg-themed .dg-results row.dg-result:selected {
  background-image: linear-gradient(95deg, rgba(${accent}, 0.22), rgba(103, 166, 195, 0.11));
  box-shadow: inset 3px 0 rgba(${accent}, 0.94);
}

.dg-themed .dg-result-title {
  font-size: 14px;
  font-weight: 650;
}

.dg-themed .dg-result-subtitle {
  font-size: 11px;
  color: #a5bccb;
}

.dg-themed .dg-ai-turn {
  color: #e7f0f5;
  margin: 2px 0;
  border-radius: 10px;
}

.dg-themed .dg-ai-question {
  background-color: rgba(${accent}, 0.10);
}

.dg-themed .dg-footer {
  border-top: 1px solid rgba(177, 216, 231, 0.14);
  color: #acc5d2;
  font-size: 11px;
}

.dg-themed .dg-keycap {
  background-color: rgba(161, 207, 217, 0.10);
  border: 1px solid rgba(161, 207, 217, 0.15);
  border-radius: 4px;
  color: #d6e8ed;
  padding: 1px 5px;
}
`;
}

export function styleWindow(
  window: Window,
  frame: Widget,
  header: Widget,
): void {
  window.addCssClass("dg-themed");
  frame.addCssClass("dg-frame");
  header.addCssClass("dg-header");
}

export class LauncherTheme {
  #provider?: CssProvider;

  install(window: Window, settings: AppearanceSettings): void {
    const provider = this.#provider = new CssProvider();
    this.preview(settings);
    // GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
    StyleContext.addProviderForDisplay(window.getDisplay(), provider, 600);
  }

  preview(settings: AppearanceSettings): void {
    this.#provider?.loadFromData(
      settings.theme === "glass" ? glassCss(settings) : "",
    );
  }
}
