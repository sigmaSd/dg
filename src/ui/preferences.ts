import { AdwApplicationWindow, HeaderBar, ToolbarView } from "@sigmasd/gtk/adw";
import { SimpleAction } from "@sigmasd/gtk/gio";
import {
  Align,
  type Application,
  Box,
  Button,
  Entry,
  Label,
  ListBox,
  ListBoxRow,
  Orientation,
  ScrolledWindow,
  Switch,
  type Widget,
  type Window,
} from "@sigmasd/gtk/gtk4";
import type { PluginControl } from "../loader.ts";
import { terminalShortcut } from "../plugins/core/terminal.ts";
import { createIcon } from "./choice-picker.ts";

export interface PluginPreferencesPage {
  icon: string;
  availableWhenDisabled?: boolean;
  create: (window: Window, setBusy: (busy: boolean) => void) => Widget;
}

function triggerDescription(plugin: PluginControl, value: string): string {
  return plugin.key === "core:terminal" && value === terminalShortcut
    ? `Type ${value} before a shell command`
    : `Type ${value} followed by a space`;
}

export function openPreferences(
  parent: Window,
  app: Application,
  plugins: readonly PluginControl[],
  pages: ReadonlyMap<string, PluginPreferencesPage>,
  setEnabled: (key: string, enabled: boolean, window: Window) => Promise<void>,
  setTrigger: (key: string, trigger: string) => Promise<void>,
  onClosed: () => void,
): AdwApplicationWindow {
  const window = new AdwApplicationWindow(app);
  window.setTransientFor(parent);
  window.setModal(true);
  window.setTitle("Preferences");
  window.setDefaultSize(600, 450);
  // Escape is already bound to win.hide on the application.
  const close = new SimpleAction("hide");
  close.connect("activate", () => window.close());
  window.addAction(close);

  const toolbar = new ToolbarView();
  const header = new HeaderBar();
  toolbar.addTopBar(header);
  window.setContent(toolbar);

  const back = new Button();
  back.setIconName("go-previous-symbolic");
  back.setTooltipText("Back to Plugins");
  back.setVisible(false);
  header.packStart(back);

  const content = new Box(Orientation.VERTICAL, 0);
  toolbar.setContent(content);
  const overview = new Box(Orientation.VERTICAL, 12);
  overview.setMarginTop(16);
  overview.setMarginBottom(16);
  overview.setMarginStart(20);
  overview.setMarginEnd(20);
  content.append(overview);

  const heading = new Label("Plugins");
  heading.addCssClass("title-2");
  heading.setXalign(0);
  overview.append(heading);

  const list = new ListBox();
  list.addCssClass("boxed-list");
  const scroller = new ScrolledWindow();
  scroller.setVexpand(true);
  scroller.setProperty("hscrollbar-policy", 2); // GTK_POLICY_NEVER
  scroller.setChild(list);
  overview.append(scroller);

  const status = new Label("");
  status.addCssClass("error");
  status.setXalign(0);
  status.setWrap(true);
  status.setVisible(false);
  overview.append(status);

  let pendingChanges = 0;
  let active: Widget | undefined;
  let activeOptions: Button | undefined;
  const panels = new Map<string, Widget>();
  const setBusy = (value: boolean) => {
    pendingChanges += value ? 1 : -1;
    back.setSensitive(pendingChanges === 0);
  };
  window.onCloseRequest(() => {
    if (pendingChanges) return true;
    onClosed();
    return false;
  });

  back.onClick(() => {
    if (pendingChanges) return;
    active?.setVisible(false);
    active = undefined;
    back.setVisible(false);
    overview.setVisible(true);
    window.setTitle("Preferences");
    activeOptions?.grabFocus();
  });

  const states = new Map(plugins.map(({ key, enabled }) => [key, enabled]));
  list.setSelectionMode(0); // GTK_SELECTION_NONE
  plugins.forEach((plugin) => {
    const row = new ListBoxRow();
    const page = pages.get(plugin.key);
    row.setProperty("activatable", false);
    const box = new Box(Orientation.HORIZONTAL, 12);
    box.setMarginTop(8);
    box.setMarginBottom(8);
    box.setMarginStart(12);
    box.setMarginEnd(12);
    box.append(createIcon(page?.icon ?? "application-x-addon-symbolic"));
    const text = new Box(Orientation.VERTICAL, 4);
    text.setHexpand(true);
    const label = new Label(plugin.title);
    label.setXalign(0);
    label.setEllipsize(3); // PANGO_ELLIPSIZE_END
    text.append(label);
    if (plugin.description) {
      const description = new Label(plugin.description);
      description.setXalign(0);
      description.setWrap(true);
      description.addCssClass("dim-label");
      text.append(description);
    }
    const trigger = !plugin.unavailableReason && plugin.trigger &&
      new Label(triggerDescription(plugin, plugin.trigger));
    if (trigger) {
      trigger.setXalign(0);
      trigger.setWrap(true);
      trigger.addCssClass("dim-label");
      text.append(trigger);
    }
    const startupError = new Label(
      plugin.error
        ? `Could not start: ${plugin.error}`
        : plugin.unavailableReason ?? "",
    );
    startupError.setXalign(0);
    startupError.setWrap(true);
    startupError.addCssClass(plugin.error ? "error" : "dim-label");
    startupError.setVisible(Boolean(plugin.error || plugin.unavailableReason));
    text.append(startupError);
    box.append(text);

    const canConfigure = () =>
      Boolean(
        trigger || page?.availableWhenDisabled || states.get(plugin.key),
      );
    const options = (page || trigger) && new Button("Settings");
    if (options) {
      options.setValign(Align.CENTER);
      options.setSensitive(canConfigure());
      options.setTooltipText(`${plugin.title} Settings`);
      options.onClick(() => {
        if (pendingChanges || !canConfigure()) return;
        let panel = panels.get(plugin.key);
        if (!panel) {
          if (trigger && plugin.trigger) {
            const body = new Box(Orientation.VERTICAL, 12);
            body.append(
              createTriggerEditor(plugin.trigger, setBusy, async (value) => {
                await setTrigger(plugin.key, value);
                trigger.setText(triggerDescription(plugin, value));
              }),
            );
            if (page) body.append(page.create(window, setBusy));
            const scroll = new ScrolledWindow();
            scroll.setVexpand(true);
            scroll.setProperty("hscrollbar-policy", 2); // GTK_POLICY_NEVER
            scroll.setChild(body);
            panel = scroll;
          } else if (page) {
            panel = page.create(window, setBusy);
          }
          if (!panel) return;
          panels.set(plugin.key, panel);
          content.append(panel);
        }
        active = panel;
        activeOptions = options;
        overview.setVisible(false);
        active.setVisible(true);
        window.setTitle(plugin.title);
        back.setVisible(true);
        back.grabFocus();
      });
      box.append(options);
    }
    const toggle = new Switch();
    toggle.setActive(plugin.enabled);
    toggle.setSensitive(!plugin.unavailableReason);
    toggle.setTooltipText(`Enable ${plugin.title}`);
    toggle.setValign(Align.CENTER);
    box.append(toggle);

    let changing = false;
    toggle.onActivate(async () => {
      const previous = states.get(plugin.key) ?? false;
      const enabled = toggle.getActive();
      if (changing || enabled === previous) return;
      changing = true;
      toggle.setSensitive(false);
      status.setVisible(false);
      setBusy(true);
      try {
        await setEnabled(plugin.key, enabled, window);
        states.set(plugin.key, enabled);
        startupError.setVisible(false);
        if (options) options.setSensitive(canConfigure());
      } catch (error) {
        toggle.setActive(previous);
        const message = error instanceof Error ? error.message : String(error);
        status.setText(`${plugin.title}: ${message}`);
        status.setVisible(true);
      } finally {
        setBusy(false);
        changing = false;
        toggle.setSensitive(true);
      }
    });
    row.setChild(box);
    list.append(row);
  });
  window.present();
  return window;
}

function createTriggerEditor(
  saved: string,
  setBusy: (busy: boolean) => void,
  save: (value: string) => Promise<void>,
): Box {
  const form = new Box(Orientation.VERTICAL, 8);
  form.setMarginTop(16);
  form.setMarginStart(20);
  form.setMarginEnd(20);
  const label = new Label("Trigger");
  label.setXalign(0);
  label.addCssClass("heading");
  form.append(label);

  const row = new Box(Orientation.HORIZONTAL, 8);
  const entry = new Entry();
  entry.setText(saved);
  entry.setHexpand(true);
  entry.setTooltipText("Trigger shortcut");
  const button = new Button("Save Trigger");
  button.setSensitive(false);
  row.append(entry);
  row.append(button);
  form.append(row);

  const status = new Label("");
  status.setXalign(0);
  status.setWrap(true);
  status.setVisible(false);
  form.append(status);

  entry.onChanged(() => {
    button.setSensitive(entry.getText().trim() !== saved);
    status.setVisible(false);
  });
  const apply = async () => {
    const value = entry.getText().trim();
    if (!button.getSensitive()) return;
    setBusy(true);
    form.setSensitive(false);
    try {
      await save(value);
      saved = value;
      entry.setText(value);
      status.removeCssClass("error");
      status.setText("Trigger saved");
    } catch (error) {
      status.addCssClass("error");
      status.setText(error instanceof Error ? error.message : String(error));
    } finally {
      button.setSensitive(entry.getText().trim() !== saved);
      form.setSensitive(true);
      setBusy(false);
      status.setVisible(true);
    }
  };
  button.onClick(apply);
  entry.onActivate(apply);
  return form;
}
