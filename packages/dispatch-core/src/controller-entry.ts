import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from './launch.js';
import type { LaunchEvent } from './types.js';
import type { ControllerMetadata } from './types-background.js';

function parseArgs(argv: string[]): { reviewId: string; dir: string } {
  let reviewId = '';
  let dir = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--review-id' && argv[i + 1]) {
      reviewId = argv[i + 1]!;
      i++;
    } else if (argv[i] === '--dir' && argv[i + 1]) {
      dir = argv[i + 1]!;
      i++;
    }
  }
  if (!reviewId || !dir) {
    console.error('Usage: controller-entry --review-id <id> --dir <path>');
    process.exit(2);
  }
  return { reviewId, dir };
}

function writeControllerJson(metadataDir: string, data: ControllerMetadata): void {
  writeFileSync(join(metadataDir, 'controller.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

async function main(): Promise<void> {
  const { reviewId, dir } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const controllerPid = process.pid;

  let metadataDir: string | null = null;

  const controllerState: ControllerMetadata = {
    schema_version: 1,
    review_id: reviewId,
    run_id: null,
    controller_pid: controllerPid,
    started_at: startedAt,
    confirmed_child_start_at: null,
    completed_at: null,
    status: 'launching',
    error: null,
  };

  const onEvent = (event: LaunchEvent): void => {
    if (event.type === 'run_created') {
      metadataDir = join(event.runDir, 'metadata');
      controllerState.run_id = event.runId;
      controllerState.status = 'launching';
      writeControllerJson(metadataDir, controllerState);
    } else if (event.type === 'token_consumed' && metadataDir) {
      controllerState.confirmed_child_start_at = new Date().toISOString();
      writeControllerJson(metadataDir, controllerState);
    } else if (event.type === 'finalized' && metadataDir) {
      controllerState.status = 'completed';
      controllerState.completed_at = new Date().toISOString();
      writeControllerJson(metadataDir, controllerState);
    }
  };

  const result = await launch({ reviewId, dir, onEvent });

  if (metadataDir) {
    if (result.ok) {
      controllerState.status = 'completed';
    } else {
      controllerState.status = result.error === 'TOKEN_INVALID' || result.error === 'HASH_MISMATCH'
        ? 'rejected'
        : 'failed';
      controllerState.error = result.message;
    }
    controllerState.completed_at = controllerState.completed_at ?? new Date().toISOString();
    writeControllerJson(metadataDir, controllerState);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Controller fatal error:', err);
  process.exit(1);
});
