import { createInterface } from "node:readline/promises";

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a line without echoing it (for tokens). */
export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return ask(question);
  }
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) {
        reject(err);
      } else {
        resolve(value.trim());
      }
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          done();
          return;
        }
        if (ch === "\u0003") {
          done(new Error("Cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}
