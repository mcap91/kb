/**
 * WK-0161 — mechanical drift-check gate for the golden fixtures under
 * `tests/fixtures/`. `tests/fixtures/capture-manifest.json` records the CLI
 * version each family's fixtures were captured with; this test fails when
 * Pi's recorded version drifts from the in-code `PI_HARNESS_INFO.testedWith`
 * gate (model-registry.ts) — the mechanical reminder that a `testedWith`
 * bump needs a matching re-capture before it merges. Full procedure:
 * docs/verify-dispatch.md's "Mechanical gate" section.
 *
 * Pi-only by design: `PI_HARNESS_INFO` is the only harness version gate that
 * exists today — its own doc comment in model-registry.ts calls it "kb's
 * only compatibility claim". Codex and Claude have no `testedWith` gate, so
 * there is nothing yet for their manifest entries to be mechanically
 * checked against; this test intentionally does not gate them (see
 * docs/verify-dispatch.md's "When to re-capture" section). Extend this test
 * if/when a version gate is added for those families.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PI_HARNESS_INFO } from '../packages/dispatch-core/src/model-registry.js';

interface CaptureManifest {
  pi: { capturedWith: string; fixtures: string[] };
  codex: { capturedWith: string; fixtures: string[] };
  claude: { capturedWith: string; fixtures: string[] };
}

describe('tests/fixtures/capture-manifest.json — Pi golden-fixture drift gate (WK-0161)', () => {
  it("fails when the manifest's pi capturedWith drifts from PI_HARNESS_INFO.testedWith", () => {
    const manifestPath = join(__dirname, 'fixtures', 'capture-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CaptureManifest;

    expect(
      manifest.pi.capturedWith,
      `tests/fixtures/capture-manifest.json's pi.capturedWith ("${manifest.pi.capturedWith}") no ` +
        `longer matches PI_HARNESS_INFO.testedWith ("${PI_HARNESS_INFO.testedWith}") in ` +
        `model-registry.ts. Re-capture Pi's golden fixtures under tests/fixtures/ and update this ` +
        `manifest entry — see docs/verify-dispatch.md's "Mechanical gate" section.`,
    ).toBe(PI_HARNESS_INFO.testedWith);
  });
});
