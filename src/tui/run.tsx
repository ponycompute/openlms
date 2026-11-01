import { render } from "ink";
import { Lms, type LmsOptions } from "../lms.js";
import { App } from "./App.js";

export async function runTui(opts: LmsOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("`openlms tui` needs an interactive terminal");
  }
  const lms = new Lms(opts);
  try {
    const instance = render(<App lms={lms} />);
    await instance.waitUntilExit();
  } finally {
    lms.close();
  }
}
