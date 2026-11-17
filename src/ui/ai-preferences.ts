import {
  Align,
  Box,
  Button,
  Entry,
  Label,
  Orientation,
  Switch,
} from "@sigmasd/gtk/gtk4";
import {
  defaultOpencodeModel,
  defaultOpencodeTools,
  type OpencodeConfig,
  type OpencodeToolsConfig,
} from "../config.ts";

const toolNames: Record<keyof OpencodeToolsConfig, string> = {
  read: "Read files",
  grep: "Search file contents",
  glob: "Find files by name",
  edit: "Edit files",
  write: "Write files",
  bash: "Run shell commands",
  task: "Start subagents",
  external_directory: "Access external directories",
};

export function createAiPreferences(
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
  model.setPlaceholderText("provider/model-id");
  model.setTooltipText("OpenCode Model");
  model.setText(settings?.model || defaultOpencodeModel);
  form.append(model);

  const toolLabel = new Label("Tool Access");
  toolLabel.addCssClass("heading");
  toolLabel.setXalign(0);
  form.append(toolLabel);
  const tools = { ...(settings?.tools ?? defaultOpencodeTools) };
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

  for (const key of Object.keys(toolNames) as (keyof OpencodeToolsConfig)[]) {
    const row = new Box(Orientation.HORIZONTAL, 10);
    const label = new Label(toolNames[key]);
    label.setXalign(0);
    label.setHexpand(true);
    const toggle = new Switch();
    toggle.setActive(Boolean(tools[key]));
    toggle.setTooltipText(toolNames[key]);
    toggle.onActivate(() => {
      tools[key] = toggle.getActive();
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
    if (!/^[^/\s]+\/\S+$/.test(value)) {
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
