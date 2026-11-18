import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export async function findExecutable(
  executable: string,
): Promise<string | undefined> {
  const paths = isAbsolute(executable)
    ? [executable]
    : (Deno.env.get("PATH") ?? "").split(delimiter).filter(isAbsolute).map((
      dir,
    ) => join(dir, executable));
  for (const path of paths) {
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") {
        throw error;
      }
    }
  }
}
