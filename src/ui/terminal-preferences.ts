import {
  Align,
  Box,
  Button,
  DropDown,
  Entry,
  Label,
  Orientation,
  StringList,
} from "@sigmasd/gtk/gtk4";
import type {
  TerminalSettings,
  TerminalSource,
} from "../plugins/core/terminal.ts";

export function createTerminalPreferences(
  preferences: Awaited<ReturnType<TerminalSource["preferences"]>>,
  setBusy: (busy: boolean) => void,
  save: (settings: TerminalSettings) => Promise<void>,
): Box {
  const { settings, choices, defaultShell } = preferences;
  const form = new Box(Orientation.VERTICAL, 12);
  form.setMarginStart(20);
  form.setMarginEnd(20);
  form.setMarginBottom(16);

  const terminalLabel = new Label("Terminal App");
  terminalLabel.setXalign(0);
  terminalLabel.addCssClass("heading");
  form.append(terminalLabel);
  const apps = new StringList();
  for (const { title } of choices) apps.append(title);
  const terminal = new DropDown(apps);
  terminal.setTooltipText("Terminal App");
  terminal.setSelected(choices.findIndex(({ id }) => id === settings.terminal));
  form.append(terminal);

  const shellLabel = new Label("Shell Executable");
  shellLabel.setXalign(0);
  shellLabel.addCssClass("heading");
  form.append(shellLabel);
  const shell = new Entry();
  shell.setText(settings.shell);
  shell.setPlaceholderText(defaultShell);
  shell.setTooltipText("Shell Executable");
  form.append(shell);

  const button = new Button("Save Terminal Settings");
  button.addCssClass("suggested-action");
  button.setHalign(Align.END);
  button.setSensitive(false);
  form.append(button);
  const status = new Label("");
  status.setXalign(0);
  status.setWrap(true);
  status.setVisible(false);
  form.append(status);

  let saved = settings;
  const formSettings = () => ({
    terminal: choices[terminal.getSelected()].id,
    shell: shell.getText().trim(),
  });
  const changed = () => {
    const { terminal, shell } = formSettings();
    button.setSensitive(terminal !== saved.terminal || shell !== saved.shell);
    status.setVisible(false);
  };
  terminal.onSelectedChanged(changed);
  shell.onChanged(changed);

  button.onClick(async () => {
    const next = formSettings();
    setBusy(true);
    form.setSensitive(false);
    try {
      await save(next);
      saved = next;
      shell.setText(saved.shell);
      button.setSensitive(false);
      status.removeCssClass("error");
      status.setText("Terminal settings saved");
    } catch (error) {
      status.addCssClass("error");
      status.setText(error instanceof Error ? error.message : String(error));
    } finally {
      form.setSensitive(true);
      setBusy(false);
      status.setVisible(true);
    }
  });
  return form;
}
