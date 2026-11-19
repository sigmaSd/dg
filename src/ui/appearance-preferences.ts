import {
  Adjustment,
  Align,
  Box,
  Button,
  DropDown,
  Label,
  Orientation,
  Scale,
  StringList,
} from "@sigmasd/gtk/gtk4";
import {
  type AppearanceSettings,
  defaultAppearance,
  glassColors,
  maxTransparency,
} from "../config.ts";

export interface AppearancePreferencesOptions {
  settings: AppearanceSettings;
  preview: (settings: AppearanceSettings) => void;
  save: (settings: AppearanceSettings) => Promise<void>;
}

export function createAppearancePreferences(
  options: AppearancePreferencesOptions,
  setBusy: (busy: boolean) => void,
) {
  let saved = options.settings;
  let restoring = false;
  const view = new Box(Orientation.VERTICAL, 16);
  view.setMarginTop(16);
  view.setMarginBottom(20);
  view.setMarginStart(20);
  view.setMarginEnd(20);

  const themeRow = new Box(Orientation.HORIZONTAL, 10);
  const themeLabel = new Label("Theme");
  themeLabel.setHexpand(true);
  themeLabel.setXalign(0);
  themeRow.append(themeLabel);
  const theme = new DropDown(new StringList(["Glass", "System"]));
  theme.setTooltipText("Theme");
  theme.setSelected(saved.theme === "glass" ? 0 : 1);
  themeRow.append(theme);
  view.append(themeRow);

  const colorRow = new Box(Orientation.HORIZONTAL, 10);
  const colorLabel = new Label("Glass color");
  colorLabel.setHexpand(true);
  colorLabel.setXalign(0);
  colorRow.append(colorLabel);
  const color = new DropDown(
    new StringList(["Ocean", "Iris", "Ember", "Graphite"]),
  );
  color.setTooltipText("Glass color");
  color.setSelected(glassColors.indexOf(saved.color));
  colorRow.append(color);
  view.append(colorRow);

  const slider = new Box(Orientation.VERTICAL, 8);
  const sliderTitle = new Box(Orientation.HORIZONTAL, 10);
  const sliderLabel = new Label("Glass transparency");
  sliderLabel.setHexpand(true);
  sliderLabel.setXalign(0);
  sliderTitle.append(sliderLabel);
  const percent = new Label("");
  percent.addCssClass("dim-label");
  sliderTitle.append(percent);
  slider.append(sliderTitle);

  const adjustment = new Adjustment(
    saved.transparency,
    0,
    maxTransparency,
    1,
    5,
    0,
  );
  const transparency = new Scale(Orientation.HORIZONTAL, adjustment);
  transparency.setDrawValue(false);
  transparency.setTooltipText("Glass background transparency");
  slider.append(transparency);
  view.append(slider);

  const save = new Button("Save Appearance");
  save.addCssClass("suggested-action");
  save.setHalign(Align.END);
  view.append(save);
  const status = new Label("");
  status.setXalign(0);
  status.setWrap(true);
  status.setVisible(false);
  view.append(status);

  const read = (): AppearanceSettings => ({
    theme: theme.getSelected() === 1 ? "system" : "glass",
    color: glassColors[color.getSelected()] ?? defaultAppearance.color,
    transparency: Math.round(adjustment.getValue()),
  });

  const sync = (settings: AppearanceSettings) => {
    colorRow.setSensitive(settings.theme === "glass");
    slider.setSensitive(settings.theme === "glass");
    percent.setText(`${settings.transparency}%`);
    save.setSensitive(
      settings.theme !== saved.theme || settings.color !== saved.color ||
        settings.transparency !== saved.transparency,
    );
  };

  const changed = () => {
    if (restoring) return;
    const settings = read();
    status.setVisible(false);
    sync(settings);
    options.preview(settings);
  };

  theme.onSelectedChanged(changed);
  color.onSelectedChanged(changed);
  transparency.onValueChanged(changed);
  sync(saved);

  save.onClick(async () => {
    const settings = read();
    setBusy(true);
    view.setSensitive(false);
    try {
      await options.save(settings);
      saved = settings;
      status.removeCssClass("error");
      status.setText("Appearance saved");
    } catch (error) {
      status.addCssClass("error");
      status.setText(error instanceof Error ? error.message : String(error));
    } finally {
      sync(settings);
      view.setSensitive(true);
      status.setVisible(true);
      setBusy(false);
    }
  });

  return {
    view,
    restore() {
      restoring = true;
      theme.setSelected(saved.theme === "glass" ? 0 : 1);
      color.setSelected(glassColors.indexOf(saved.color));
      adjustment.setValue(saved.transparency);
      restoring = false;
      status.setVisible(false);
      sync(saved);
      options.preview(saved);
    },
  };
}
