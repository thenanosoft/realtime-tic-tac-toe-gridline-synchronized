import { describe, expect, it } from 'vitest';
import { generateTemporaryName, TEMPORARY_NAME_PATTERN } from '../server/rooms/identity';

describe('temporary player identities', () => {
  it('generates short, readable adjective-animal names', () => {
    const name = generateTemporaryName(new Set(), () => 0);
    expect(name).toMatch(TEMPORARY_NAME_PATTERN);
    expect(name.length).toBeLessThanOrEqual(24);
  });

  it('skips a collision inside the same room', () => {
    const first = generateTemporaryName(new Set(), () => 0);
    const second = generateTemporaryName(new Set([first]), () => 0);
    expect(second).not.toBe(first);
    expect(second).toMatch(TEMPORARY_NAME_PATTERN);
  });

  it('does not create a permanent global identity registry', () => {
    expect(generateTemporaryName(new Set(), () => 0)).toBe(generateTemporaryName(new Set(), () => 0));
  });
});
