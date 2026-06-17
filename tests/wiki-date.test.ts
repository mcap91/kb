/**
 * Unit tests for the local date-stamp helper (WK-0038).
 *
 * Locks local-timezone date stamping across a UTC day boundary so wiki records'
 * date-only fields (e.g. an issue's `created` / `updated`) match git commit dates
 * and the human "today", instead of UTC's `toISOString().slice(0, 10)` rolling to
 * tomorrow in the evening of a UTC-negative timezone.
 */

import { describe, it, expect } from 'vitest';

import { localDateStamp } from '../packages/wiki-core/src/date.js';

describe('localDateStamp', () => {
  // 2026-06-17T02:57:00Z is 2026-06-16 19:57 in America/Los_Angeles (UTC-7, PDT) —
  // the exact near-midnight-UTC instant that triggered WK-0038.
  const nearMidnightUtc = new Date('2026-06-17T02:57:00Z');

  it('stamps the LOCAL date in a UTC-negative timezone, not the UTC date', () => {
    expect(localDateStamp(nearMidnightUtc, 'America/Los_Angeles')).toBe('2026-06-16');
  });

  it('diverges from toISOString().slice(0, 10) across the boundary (the bug)', () => {
    // The old code stamped the UTC date — tomorrow — for this instant.
    expect(nearMidnightUtc.toISOString().slice(0, 10)).toBe('2026-06-17');
    expect(localDateStamp(nearMidnightUtc, 'America/Los_Angeles')).not.toBe(
      nearMidnightUtc.toISOString().slice(0, 10),
    );
  });

  it('is timezone-aware — the same instant rolls forward in a UTC-positive zone', () => {
    // Asia/Tokyo is UTC+9, so the same instant is 2026-06-17 11:57 local.
    expect(localDateStamp(nearMidnightUtc, 'Asia/Tokyo')).toBe('2026-06-17');
  });

  it('returns a date-only YYYY-MM-DD string (no time component)', () => {
    expect(localDateStamp(nearMidnightUtc, 'America/Los_Angeles')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
