import { Key, ModifierType } from "@sigmasd/gtk/gtk4";

const modifiers = ModifierType.SHIFT_MASK | ModifierType.CONTROL_MASK |
  ModifierType.ALT_MASK;

/**
 * Rows a key press moves the result highlight by: -1 for Up or Ctrl+P, 1 for
 * Down or Ctrl+N, and 0 for every other key. Shift+Up and Shift+Down are left
 * to the search entry for selecting text. Caps Lock is ignored.
 */
export function resultStep(keyval: number, state: number): number {
  const held = state & modifiers;
  if (held === 0) {
    if (keyval === Key.Up || keyval === Key.KP_Up) return -1;
    if (keyval === Key.Down || keyval === Key.KP_Down) return 1;
  }
  if (held === ModifierType.CONTROL_MASK) {
    if (keyval === Key.p || keyval === Key.P) return -1;
    if (keyval === Key.n || keyval === Key.N) return 1;
  }
  return 0;
}
