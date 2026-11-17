import {
  Align,
  Box,
  Button,
  DropDown,
  Label,
  ListBox,
  ListBoxRow,
  Orientation,
  ScrolledWindow,
  StringList,
  type Window,
} from "@sigmasd/gtk/gtk4";
import {
  type PathSource,
  pathTargets,
  systemPathActions,
} from "../plugins/core/paths.ts";
import { createIcon, showChoicePicker } from "./choice-picker.ts";

const targetLabels = ["Files and Folders", "Files Only", "Folders Only"];

export function createPathPreferences(
  window: Window,
  source: PathSource,
  setBusy: (busy: boolean) => void,
  onSaved: () => void,
): Box {
  const actions = [...source.actions];

  const content = new Box(Orientation.VERTICAL, 12);
  content.setVexpand(true);
  content.setMarginTop(16);
  content.setMarginBottom(16);
  content.setMarginStart(20);
  content.setMarginEnd(20);

  const intro = new Box(Orientation.VERTICAL, 4);
  const heading = new Label("Path Actions");
  heading.addCssClass("title-2");
  heading.setXalign(0);
  intro.append(heading);
  const help = new Label(
    "Choose what appears when you paste a path. Enter runs the first applicable action.",
  );
  help.addCssClass("dim-label");
  help.setXalign(0);
  help.setWrap(true);
  intro.append(help);
  content.append(intro);

  const scroller = new ScrolledWindow();
  scroller.setVexpand(true);
  scroller.setProperty("hscrollbar-policy", 2); // GTK_POLICY_NEVER
  content.append(scroller);
  const list = new ListBox();
  list.addCssClass("boxed-list");
  list.setSelectionMode(0); // GTK_SELECTION_NONE
  scroller.setChild(list);

  const empty = new Label("No path actions configured");
  empty.addCssClass("dim-label");
  content.append(empty);

  const buttons = new Box(Orientation.HORIZONTAL, 8);
  const addApp = new Button("Add App…");
  const addSystem = new Button("Add System Action…");
  const save = new Button("Save");
  save.addCssClass("suggested-action");
  save.setSensitive(false);
  const spacer = new Box(Orientation.HORIZONTAL, 0);
  spacer.setHexpand(true);
  buttons.append(addApp);
  buttons.append(addSystem);
  buttons.append(spacer);
  buttons.append(save);
  content.append(buttons);

  const status = new Label("");
  status.setWrap(true);
  status.setXalign(0);
  status.setVisible(false);
  content.append(status);

  const systemChoices = (["default", "reveal"] as const).map((kind) => ({
    ...systemPathActions[kind],
    id: kind,
  }));
  const appChoices = Array.from(source.desktopApps, ([id, app]) => ({
    id,
    title: app.name,
    icon: app.icon || "application-x-executable",
  }));

  function changed() {
    status.setVisible(false);
    save.setSensitive(true);
  }

  function render(focus?: { index: number; move: -1 | 1 }) {
    list.removeAll();
    empty.setVisible(actions.length === 0);
    scroller.setVisible(actions.length > 0);
    addApp.setSensitive(appChoices.some(({ id }) => !hasApp(id)));
    addSystem.setSensitive(
      systemChoices.some(({ id }) => !hasSystemAction(id)),
    );

    actions.forEach((action, index) => {
      const app = action.kind === "app"
        ? source.desktopApps.get(action.desktopId)
        : undefined;
      const { title, icon } = action.kind === "app"
        ? {
          title: app?.name ?? `${action.desktopId} (Unavailable)`,
          icon: app?.icon || "application-x-executable",
        }
        : systemPathActions[action.kind];
      const row = new ListBoxRow();
      row.setProperty("activatable", false);
      const box = new Box(Orientation.HORIZONTAL, 8);
      box.setMarginTop(7);
      box.setMarginBottom(7);
      box.setMarginStart(12);
      box.setMarginEnd(12);
      box.append(createIcon(icon));

      const label = new Label(title);
      label.setXalign(0);
      label.setEllipsize(3); // PANGO_ELLIPSIZE_END
      label.setHexpand(true);
      box.append(label);

      const targets = new StringList();
      for (const target of targetLabels) targets.append(target);
      const targetPicker = new DropDown(targets);
      targetPicker.setSelected(pathTargets.indexOf(action.target));
      targetPicker.setTooltipText(`Apply ${title} to`);
      targetPicker.setValign(Align.CENTER);
      targetPicker.onSelectedChanged((selected) => {
        const target = pathTargets[selected];
        if (!target) return;
        actions[index] = { ...actions[index], target };
        changed();
      });
      box.append(targetPicker);

      const move = (offset: -1 | 1) => {
        const next = index + offset;
        [actions[index], actions[next]] = [actions[next], actions[index]];
        changed();
        render({ index: next, move: offset });
      };
      const controls = new Box(Orientation.HORIZONTAL, 0);
      controls.addCssClass("linked");
      controls.setValign(Align.CENTER);
      const up = iconButton(
        "go-up-symbolic",
        `Move ${title} Up`,
        () => move(-1),
      );
      up.setSensitive(index > 0);
      const down = iconButton(
        "go-down-symbolic",
        `Move ${title} Down`,
        () => move(1),
      );
      down.setSensitive(index < actions.length - 1);
      controls.append(up);
      controls.append(down);
      controls.append(
        iconButton("list-remove-symbolic", `Remove ${title}`, () => {
          actions.splice(index, 1);
          changed();
          render();
          const add = action.kind === "app" ? addApp : addSystem;
          add.grabFocus();
        }),
      );
      box.append(controls);

      row.setChild(box);
      list.append(row);
      if (focus?.index === index) {
        const preferred = focus.move === -1 ? up : down;
        (preferred.getSensitive() ? preferred : focus.move === -1 ? down : up)
          .grabFocus();
      }
    });
  }

  const hasApp = (id: string) =>
    actions.some((action) => action.kind === "app" && action.desktopId === id);
  const hasSystemAction = (id: string) =>
    actions.some((action) => action.kind === id);

  addApp.onClick(() =>
    showChoicePicker(window, {
      title: "Add App",
      choices: appChoices.filter(({ id }) => !hasApp(id)),
      searchPlaceholder: "Search installed apps…",
      onSelect: ({ id }) => {
        actions.push({ kind: "app", desktopId: id, target: "both" });
        changed();
        render();
      },
    })
  );
  addSystem.onClick(() =>
    showChoicePicker(window, {
      title: "Add System Action",
      choices: systemChoices.filter(({ id }) => !hasSystemAction(id)),
      onSelect: ({ id }) => {
        actions.push({ kind: id, target: id === "reveal" ? "files" : "both" });
        changed();
        render();
      },
    })
  );
  save.onClick(async () => {
    setBusy(true);
    content.setSensitive(false);
    try {
      await source.saveActions(actions);
    } catch (cause) {
      console.error("Could not save path actions:", cause);
      status.addCssClass("error");
      status.setText("Could not save path actions. Try again.");
      status.setVisible(true);
      return;
    } finally {
      setBusy(false);
      content.setSensitive(true);
    }
    save.setSensitive(false);
    status.removeCssClass("error");
    status.setText("Saved");
    status.setVisible(true);
    onSaved();
  });

  render();
  return content;
}

function iconButton(
  icon: string,
  tooltip: string,
  handler: () => void,
): Button {
  const button = new Button();
  button.setIconName(icon);
  button.setTooltipText(tooltip);
  button.onClick(handler);
  return button;
}
