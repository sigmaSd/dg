export async function openUrl(url: string): Promise<void> {
  let executable = "gio";
  let args = ["open", url];
  if (Deno.build.os === "windows") {
    executable = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (Deno.build.os === "darwin") {
    executable = "open";
    args = [url];
  }
  const process = new Deno.Command(executable, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  if (!(await process.status).success) {
    throw new Error("Could not open the link in your default browser.");
  }
}
