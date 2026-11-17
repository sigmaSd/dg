import { AdwWindow, HeaderBar, ToolbarView } from "@sigmasd/gtk/adw";
import {
  Align,
  Box,
  Entry,
  Image,
  Label,
  ListBox,
  ListBoxRow,
  Orientation,
  ScrolledWindow,
  type Window,
} from "@sigmasd/gtk/gtk4";

export interface Choice {
  id: string;
  title: string;
  icon?: string;
}

export function createIcon(icon: string): Image {
  const image = new Image(
    icon.startsWith("/") ? { file: icon } : { iconName: icon },
  );
  image.setPixelSize(32);
  image.setValign(Align.CENTER);
  return image;
}

export function showChoicePicker<T extends Choice>(
  parent: Window,
  options: {
    title: string;
    choices: readonly T[];
    searchPlaceholder?: string;
    onSelect: (choice: T) => void;
  },
): void {
  const window = new AdwWindow();
  window.setTransientFor(parent);
  window.setModal(true);
  window.setTitle(options.title);
  window.setDefaultSize(430, options.searchPlaceholder ? 430 : 215);

  const toolbar = new ToolbarView();
  toolbar.addTopBar(new HeaderBar());
  window.setContent(toolbar);

  const content = new Box(Orientation.VERTICAL, 12);
  content.setMarginTop(12);
  content.setMarginBottom(12);
  content.setMarginStart(16);
  content.setMarginEnd(16);
  toolbar.setContent(content);

  const { searchPlaceholder } = options;
  const entry = searchPlaceholder ? new Entry() : undefined;
  if (entry && searchPlaceholder) {
    entry.setPlaceholderText(searchPlaceholder);
    content.append(entry);
  }

  const list = new ListBox();
  list.addCssClass("boxed-list");
  const scroller = new ScrolledWindow();
  scroller.setVexpand(true);
  scroller.setProperty("hscrollbar-policy", 2); // GTK_POLICY_NEVER
  scroller.setChild(list);
  content.append(scroller);

  const empty = new Label("No matches");
  empty.addCssClass("dim-label");
  empty.setVisible(options.choices.length === 0);
  content.append(empty);

  const rows = options.choices.map((choice) => {
    const row = new ListBoxRow();
    const box = new Box(Orientation.HORIZONTAL, 10);
    box.setMarginTop(6);
    box.setMarginBottom(6);
    box.setMarginStart(12);
    box.setMarginEnd(12);
    if (choice.icon) box.append(createIcon(choice.icon));
    const title = new Label(choice.title);
    title.setXalign(0);
    title.setEllipsize(3); // PANGO_ELLIPSIZE_END
    title.setHexpand(true);
    box.append(title);
    row.setChild(box);
    list.append(row);
    return {
      row,
      choice,
      searchText: `${choice.title} ${choice.id}`.toLowerCase(),
    };
  });

  const select = (choice: T) => {
    options.onSelect(choice);
    window.close();
  };
  list.onRowActivated((_row, index) => {
    const choice = options.choices[index];
    if (choice) select(choice);
  });
  if (entry) {
    entry.onChanged(() => {
      const query = entry.getText().trim().toLowerCase();
      let hasMatches = false;
      for (const { row, searchText } of rows) {
        const matches = searchText.includes(query);
        row.setVisible(matches);
        hasMatches ||= matches;
      }
      scroller.setVisible(hasMatches);
      empty.setVisible(!hasMatches);
    });
    entry.onActivate(() => {
      const match = rows.find(({ row }) => row.getVisible());
      if (match) select(match.choice);
    });
  }
  if (options.choices.length === 0) scroller.setVisible(false);

  window.present();
  entry?.grabFocus();
}
