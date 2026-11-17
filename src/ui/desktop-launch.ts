import {
  type FileManagerStartupId,
  NAUTILUS_DESKTOP_ID,
} from "../plugins/core/paths.ts";
import { openUrl as openUrlFromCommand } from "../utils/open-url.ts";

function loadSymbols() {
  // The GTK library's dependencies also provide the GIO, GLib and GObject symbols.
  return Deno.dlopen("libgtk-4.so.1", {
    gdk_display_get_app_launch_context: {
      parameters: ["pointer"],
      result: "pointer",
    },
    g_app_info_get_default_for_type: {
      parameters: ["buffer", "i32"],
      result: "pointer",
    },
    g_app_info_get_id: { parameters: ["pointer"], result: "pointer" },
    g_app_info_launch: {
      parameters: ["pointer", "pointer", "pointer", "pointer"],
      result: "i32",
    },
    g_app_info_launch_default_for_uri: {
      parameters: ["buffer", "pointer", "pointer"],
      result: "i32",
    },
    g_desktop_app_info_new_from_filename: {
      parameters: ["buffer"],
      result: "pointer",
    },
    g_file_new_for_path: { parameters: ["buffer"], result: "pointer" },
    g_list_prepend: { parameters: ["pointer", "pointer"], result: "pointer" },
    g_app_launch_context_get_startup_notify_id: {
      parameters: ["pointer", "pointer", "pointer"],
      result: "pointer",
    },
    g_list_free: { parameters: ["pointer"], result: "void" },
    g_object_unref: { parameters: ["pointer"], result: "void" },
    g_free: { parameters: ["pointer"], result: "void" },
  });
}

export function createGtkDesktopLaunch(
  getDisplay: () => Deno.PointerValue | undefined,
) {
  let native: ReturnType<typeof loadSymbols> | undefined;
  const encoder = new TextEncoder();
  const cString = (text: string) => encoder.encode(`${text}\0`);

  function withLaunchContext<T>(
    launch: (
      symbols: ReturnType<typeof loadSymbols>["symbols"],
      context: Deno.PointerObject,
    ) => T,
  ): T | undefined {
    const display = Deno.build.os === "linux" ? getDisplay() : undefined;
    if (!display) return;
    try {
      const { symbols } = native ??= loadSymbols();
      const context = symbols.gdk_display_get_app_launch_context(display);
      if (!context) return;
      try {
        return launch(symbols, context);
      } finally {
        symbols.g_object_unref(context);
      }
    } catch (error) {
      console.warn("Could not use the GTK launch context:", error);
    }
  }

  const fileManagerStartupId: FileManagerStartupId = (
    path,
    { desktopFile, nautilusOnly } = {},
  ) =>
    withLaunchContext((symbols, context) => {
      const app = desktopFile
        ? symbols.g_desktop_app_info_new_from_filename(cString(desktopFile))
        : symbols.g_app_info_get_default_for_type(
          cString("inode/directory"),
          0,
        );
      if (!app) return;
      try {
        if (nautilusOnly && !desktopFile) {
          const id = symbols.g_app_info_get_id(app);
          if (
            !id ||
            new Deno.UnsafePointerView(id).getCString() !== NAUTILUS_DESKTOP_ID
          ) return;
        }

        const file = symbols.g_file_new_for_path(cString(path));
        const files = symbols.g_list_prepend(null, file);
        let token: Deno.PointerValue = null;
        try {
          token = symbols.g_app_launch_context_get_startup_notify_id(
            context,
            app,
            files,
          );
          return token
            ? new Deno.UnsafePointerView(token).getCString()
            : undefined;
        } finally {
          symbols.g_free(token);
          symbols.g_list_free(files);
          symbols.g_object_unref(file);
        }
      } finally {
        symbols.g_object_unref(app);
      }
    });

  async function openUrl(url: string): Promise<void> {
    const launched = withLaunchContext((symbols, context) =>
      symbols.g_app_info_launch_default_for_uri(cString(url), context, null)
    );
    if (!launched) await openUrlFromCommand(url);
  }

  function launchApp(desktopFile: string): boolean {
    return Boolean(withLaunchContext((symbols, context) => {
      const app = symbols.g_desktop_app_info_new_from_filename(
        cString(desktopFile),
      );
      if (!app) return false;
      try {
        return symbols.g_app_info_launch(app, null, context, null);
      } finally {
        symbols.g_object_unref(app);
      }
    }));
  }

  return { fileManagerStartupId, openUrl, launchApp };
}
