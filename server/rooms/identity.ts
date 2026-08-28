import { randomInt } from 'node:crypto';

const ADJECTIVES = [
  'Brave', 'Bright', 'Calm', 'Clever', 'Cosmic', 'Daring', 'Gentle', 'Golden',
  'Happy', 'Kind', 'Lucky', 'Mellow', 'Mighty', 'Neon', 'Nimble', 'Nova',
  'Quiet', 'Rapid', 'Silent', 'Solar', 'Spark', 'Swift', 'Tiny', 'Velvet',
] as const;

const ANIMALS = [
  'Badger', 'Bear', 'Crane', 'Falcon', 'Fox', 'Gecko', 'Heron', 'Koala',
  'Lynx', 'Otter', 'Owl', 'Panda', 'Penguin', 'Raven', 'Robin', 'Seal',
  'Sparrow', 'Tiger', 'Turtle', 'Wolf',
] as const;

export const TEMPORARY_NAME_PATTERN = /^[A-Z][a-z]+[A-Z][a-z]+$/;

export function generateTemporaryName(
  excludedNames: ReadonlySet<string> = new Set(),
  chooseIndex: (max: number) => number = randomInt,
): string {
  const combinations = ADJECTIVES.length * ANIMALS.length;
  const start = chooseIndex(combinations);

  for (let offset = 0; offset < combinations; offset += 1) {
    const index = (start + offset) % combinations;
    const adjective = ADJECTIVES[Math.floor(index / ANIMALS.length)];
    const animal = ANIMALS[index % ANIMALS.length];
    const candidate = `${adjective}${animal}`;
    if (!excludedNames.has(candidate)) return candidate;
  }

  throw new Error('Temporary identity pool exhausted.');
}
