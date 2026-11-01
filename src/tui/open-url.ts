import { spawn } from "node:child_process";

/** Opens an http(s) URL in the default browser. */
export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Refusing to open non-web URL: ${url}`);
  }
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
