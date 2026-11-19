import {
  Align,
  Box,
  Button,
  Entry,
  Label,
  Orientation,
  Switch,
  type Window,
} from "@sigmasd/gtk/gtk4";
import {
  defaultOpencodeTools,
  type OpencodeConfig,
  type OpencodeToolsConfig,
} from "../config.ts";
import { Opencode } from "../plugins/core/opencode.ts";
import { showChoicePicker } from "./choice-picker.ts";

const toolNames: Record<Exclude<keyof OpencodeToolsConfig, "write">, string> = {
  websearch: "Search the web (TinyFish)",
  webfetch: "Open web pages",
  read: "Read files",
  grep: "Search file contents",
  glob: "Find files by name",
  edit: "Edit and write files",
  bash: "Run shell commands",
  task: "Start subagents",
  external_directory: "Access external directories",
};

export function createAiPreferences(
  window: Window,
  settings: OpencodeConfig | undefined,
  setBusy: (busy: boolean) => void,
  save: (
    settings: { model: string; tools: OpencodeToolsConfig },
  ) => Promise<void>,
): Box {
  const form = new Box(Orientation.VERTICAL, 12);
  form.setMarginStart(20);
  form.setMarginEnd(20);
  form.setMarginBottom(16);

  const modelLabel = new Label("OpenCode Model");
  modelLabel.addCssClass("heading");
  modelLabel.setXalign(0);
  form.append(modelLabel);
  const model = new Entry();
  model.setPlaceholderText("OpenCode default");
  model.setTooltipText("Use provider/model-id to override OpenCode’s default");
  model.setText(settings?.model ?? "");
  model.setHexpand(true);

  const modelRow = new Box(Orientation.HORIZONTAL, 8);
  modelRow.append(model);
  const browse = new Button("Browse Models");
  modelRow.append(browse);
  form.append(modelRow);

  const defaultLabel = new Label("");
  defaultLabel.setXalign(0);
  defaultLabel.setWrap(true);
  defaultLabel.addCssClass("dim-label");
  form.append(defaultLabel);

  const controller = new AbortController();
  const { signal } = controller;
  window.onDestroy(() => controller.abort());
  let catalogue: Awaited<ReturnType<Opencode["models"]>> | undefined;

  const loadCatalogue = async () => {
    browse.setSensitive(false);
    defaultLabel.setText("Loading OpenCode models…");
    try {
      const opencode = await Opencode.open();
      try {
        catalogue = await opencode.models(signal);
      } finally {
        await opencode.close();
      }
      if (signal.aborted) return;
      defaultLabel.setText(
        catalogue.defaultModel
          ? `OpenCode default · ${catalogue.defaultModel}`
          : "OpenCode did not report a default model.",
      );
    } catch (error) {
      if (!signal.aborted) {
        defaultLabel.setText(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (!signal.aborted) browse.setSensitive(true);
    }
  };

  browse.onClick(async () => {
    if (!catalogue) await loadCatalogue();
    if (!catalogue || signal.aborted || !form.isVisible()) return;
    showChoicePicker(window, {
      title: "OpenCode Models",
      searchPlaceholder: "Search models…",
      choices: [
        {
          id: "",
          title: catalogue.defaultModel
            ? `Use OpenCode default · ${catalogue.defaultModel}`
            : "Use OpenCode default",
        },
        ...catalogue.models.map(({ id, provider, name, isFree }) => ({
          id: `${provider}/${id}`,
          title: `${name} · ${provider}/${id}${isFree ? " (free)" : ""}`,
        })),
      ],
      onSelect: (choice) => {
        if (!signal.aborted) model.setText(choice.id);
      },
    });
  });
  void loadCatalogue();

  const toolLabel = new Label("Tool Access");
  toolLabel.addCssClass("heading");
  toolLabel.setXalign(0);
  form.append(toolLabel);
  const tools = { ...defaultOpencodeTools, ...settings?.tools };
  const controls = new Box(Orientation.VERTICAL, 6);
  form.append(controls);

  const button = new Button("Save AI Settings");
  button.addCssClass("suggested-action");
  button.setHalign(Align.END);
  button.setSensitive(false);
  const status = new Label("");
  status.setXalign(0);
  status.setWrap(true);
  status.setVisible(false);
  const changed = () => {
    status.setVisible(false);
    button.setSensitive(true);
  };
  model.onChanged(changed);

  for (const key of Object.keys(toolNames) as (keyof typeof toolNames)[]) {
    const row = new Box(Orientation.HORIZONTAL, 10);
    const label = new Label(toolNames[key]);
    label.setXalign(0);
    label.setHexpand(true);
    const toggle = new Switch();
    toggle.setActive(key === "edit" ? tools.edit && tools.write : tools[key]);
    toggle.setTooltipText(toolNames[key]);
    toggle.onActivate(() => {
      tools[key] = toggle.getActive();
      if (key === "edit") tools.write = tools.edit;
      changed();
    });
    row.append(label);
    row.append(toggle);
    controls.append(row);
  }
  form.append(button);
  form.append(status);

  button.onClick(async () => {
    const value = model.getText().trim();
    if (value && !/^[^/\s]+\/\S+$/.test(value)) {
      status.addCssClass("error");
      status.setText("Use a model ID in provider/model-id format.");
      status.setVisible(true);
      return;
    }
    setBusy(true);
    form.setSensitive(false);
    try {
      await save({ model: value, tools: { ...tools } });
      model.setText(value);
      button.setSensitive(false);
      status.removeCssClass("error");
      status.setText("AI settings saved");
    } catch (error) {
      status.addCssClass("error");
      status.setText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      form.setSensitive(true);
      status.setVisible(true);
    }
  });
  return form;
}
