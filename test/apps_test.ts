import { assertEquals } from "@std/assert";
import { parseDesktopFile } from "../src/apps.ts";

Deno.test("parseDesktopFile - standard entry", () => {
  const content = `[Desktop Entry]
Name=Firefox
Exec=firefox %u
Icon=firefox
Type=Application
`;
  const app = parseDesktopFile(
    content,
    "/usr/share/applications/firefox.desktop",
  );
  assertEquals(app?.name, "Firefox");
  assertEquals(app?.exec, "firefox");
  assertEquals(app?.icon, "firefox");
});

Deno.test("parseDesktopFile - flatpak entry", () => {
  const content = `[Desktop Entry]
Name=AnyDesk
Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=anydesk --file-forwarding com.anydesk.Anydesk @@u %u @@
Icon=com.anydesk.Anydesk
Type=Application
`;
  const app = parseDesktopFile(
    content,
    "/var/lib/flatpak/exports/share/applications/com.anydesk.Anydesk.desktop",
  );
  assertEquals(app?.name, "AnyDesk");
  assertEquals(
    app?.exec,
    "/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=anydesk --file-forwarding com.anydesk.Anydesk",
  );
  assertEquals(app?.icon, "com.anydesk.Anydesk");
});

Deno.test("parseDesktopFile - NoDisplay=true", () => {
  const content = `[Desktop Entry]
Name=Secret
Exec=secret
NoDisplay=true
`;
  const app = parseDesktopFile(
    content,
    "/usr/share/applications/secret.desktop",
  );
  assertEquals(app, null);
});

Deno.test("parseDesktopFile - ignore other sections", () => {
  const content = `[Desktop Entry]
Name=Test
Exec=test

[Desktop Action NewWindow]
Name=New Window
Exec=test --new-window
`;
  const app = parseDesktopFile(content, "/usr/share/applications/test.desktop");
  assertEquals(app?.name, "Test");
  assertEquals(app?.exec, "test");
});
