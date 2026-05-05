export const VERSION = '0.0.1';

// Error types and helpers
export type { DispatchErrorCode, DispatchResult } from './errors.js';
export { ok, fail } from './errors.js';

// Dispatch types
export type {
  HandoffMode,
  HandoffStatus,
  HandoffFrontmatter,
  AgentLauncherConfig,
  AgentRegistry,
  TokenPayload,
  DispatchToken,
  ReviewOpts,
  ReviewResult,
  LaunchOpts,
  RunResult,
  CleanupOpts,
  CleanupReport,
} from './types.js';

// Zod schemas
export {
  handoffModeSchema,
  handoffStatusSchema,
  handoffFrontmatterSchema,
  agentLauncherConfigSchema,
  agentRegistrySchema,
  tokenPayloadSchema,
} from './schemas.js';

// Platform-aware paths
export type { TokenState } from './paths.js';
export {
  getConfigDir,
  getTokenDir,
  getReviewDir,
  getRunDir,
  ensureConfigDirs,
} from './paths.js';

// Token management
export {
  generateKey,
  loadKey,
  createToken,
  verifyToken,
  writeTokenFile,
  readTokenFile,
  moveToken,
} from './token.js';

// Review
export { review } from './review.js';
