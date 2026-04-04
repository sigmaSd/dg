/**
 * Utility for reading clipboard content, handling both text and images.
 * If an image is found, it is saved to a temporary file and the path is returned.
 */
export async function readClipboard(): Promise<string> {
  try {
    if (Deno.build.os === "linux") {
      // Check if wl-paste is available
      const checkCmd = new Deno.Command("which", {
        args: ["wl-paste"],
        stdout: "piped",
      });
      const { success: hasWlPaste } = await checkCmd.output();

      if (hasWlPaste) {
        // Check available types
        const listCmd = new Deno.Command("wl-paste", {
          args: ["--list-types"],
          stdout: "piped",
        });
        const { stdout: listOutput } = await listCmd.output();
        const types = new TextDecoder().decode(listOutput);

        if (
          types.includes("image/png") || types.includes("image/jpeg") ||
          types.includes("image/tiff")
        ) {
          let type = "image/png";
          let ext = "png";

          if (types.includes("image/png")) {
            type = "image/png";
            ext = "png";
          } else if (types.includes("image/jpeg")) {
            type = "image/jpeg";
            ext = "jpg";
          } else if (types.includes("image/tiff")) {
            type = "image/tiff";
            ext = "tiff";
          }

          const tempFile = await Deno.makeTempFile({
            prefix: "dg_cb_",
            suffix: `.${ext}`,
          });
          const pasteCmd = new Deno.Command("wl-paste", {
            args: ["--type", type],
            stdout: "piped",
          });
          const { stdout: imageData } = await pasteCmd.output();
          await Deno.writeFile(tempFile, imageData);
          return tempFile;
        }

        // Default to text
        const pasteCmd = new Deno.Command("wl-paste", {
          args: ["--no-newline"],
          stdout: "piped",
        });
        const { stdout: textData } = await pasteCmd.output();
        return new TextDecoder().decode(textData);
      }

      // Fallback to xclip if wl-paste is missing
      const xclipCmd = new Deno.Command("which", {
        args: ["xclip"],
        stdout: "piped",
      });
      const { success: hasXclip } = await xclipCmd.output();
      if (hasXclip) {
        const pasteCmd = new Deno.Command("xclip", {
          args: ["-selection", "clipboard", "-o"],
          stdout: "piped",
        });
        const { stdout: textData } = await pasteCmd.output();
        return new TextDecoder().decode(textData);
      }
    } else if (Deno.build.os === "windows") {
      // PowerShell script to handle both text and images
      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $image = [System.Windows.Forms.Clipboard]::GetImage()
          $tempFile = [System.IO.Path]::GetTempFileName() + ".png"
          $image.Save($tempFile, [System.Drawing.Imaging.ImageFormat]::Png)
          Write-Output $tempFile
        } else {
          Get-Clipboard
        }
      `;
      const cmd = new Deno.Command("powershell", {
        args: ["-Command", script],
        stdout: "piped",
      });
      const { stdout } = await cmd.output();
      return new TextDecoder().decode(stdout).trim();
    } else if (Deno.build.os === "darwin") {
      const cmd = new Deno.Command("pbpaste", {
        stdout: "piped",
      });
      const { stdout } = await cmd.output();
      return new TextDecoder().decode(stdout);
    }
  } catch (e) {
    console.warn("[Clipboard] Failed to read clipboard:", e);
  }
  return "";
}
