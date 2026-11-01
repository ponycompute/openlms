// Must be the first import of the entry point: silences node:sqlite's
// ExperimentalWarning, which would otherwise pollute CLI and MCP stderr.
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(text)) {
    return;
  }
  (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
