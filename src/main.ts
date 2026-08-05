// src/main.ts — esbuild entry point. This file is the only place that runs anything.
import * as core from '@actions/core';
import { run } from './index.js';

/**
 * `core.setFailed` sets the exit code without truncating in-flight work; no `process.exit()`
 * appears anywhere. `run()` already converts its one recognised failure mode, `PreflightError`,
 * into `core.setFailed` internally, so this `.catch(...)` is only the backstop for what `run()`
 * did not recognise — a bug, or an unhandled network failure.
 */
run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
