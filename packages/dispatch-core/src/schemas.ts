import { z } from 'zod';

// ---------------------------------------------------------------------------
// Handoff frontmatter Zod schema
// ---------------------------------------------------------------------------

// `handoffModeSchema` predates the v1 handoff-frontmatter schema it once fed (removed
// under WK-0118 Phase 1) but survives because `tokenPayloadSchema` below still embeds it.
export const handoffModeSchema = z.enum(['redteam', 'code_review', 'implement']);

// ---------------------------------------------------------------------------
// Token payload Zod schema
// ---------------------------------------------------------------------------

export const tokenPayloadSchema = z.object({
  reviewId: z.string(),
  handoffId: z.string(),
  agent: z.string(),
  mode: handoffModeSchema,
  repoRoot: z.string(),
  inputManifestHash: z.string(),
  registryHash: z.string(),
  expiry: z.string(),
});
