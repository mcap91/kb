/**
 * Wiki CLI entry point.
 *
 * Invoked via `npm run wiki -- <command> [options]`.
 * Parses process.argv and dispatches to the run module.
 */

import { run } from './run.js';

run(process.argv.slice(2));
