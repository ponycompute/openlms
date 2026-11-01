#!/usr/bin/env node
// Entry point. quiet.js must run before node:sqlite is loaded, and static
// imports of builtins are linked before any module body runs, so the real
// program is loaded dynamically.
import "./quiet.js";

await import("./main.js");
