import { SIGIL_SIZE, type GeneratedIdentity } from '../../shared/identityArt';

interface IdentitySigilProps {
  identity: GeneratedIdentity;
  /**
   * When false the sigil is decoration beside text that already names the
   * player, and announcing it again would just be noise.
   */
  labelled?: boolean;
}

/**
 * The generated sigil, with its description attached rather than beside it.
 *
 * P10-03 is the rule that matters here: identity is textual first. The sigil
 * carries `role="img"` and the identity's own description, so a screen reader
 * gets "CosmicOtter: an amber orbit sigil" rather than nothing - and the
 * accent colour is named in that description, never left as the only way to
 * tell two players apart.
 */
export function IdentitySigil({ identity, labelled = true }: IdentitySigilProps) {
  const cell = 100 / SIGIL_SIZE;
  const squares: string[] = [];
  for (let index = 0; index < identity.sigil.length; index += 1) {
    if (!identity.sigil[index]) continue;
    const row = Math.floor(index / SIGIL_SIZE);
    const column = index % SIGIL_SIZE;
    squares.push(`M${column * cell} ${row * cell}h${cell}v${cell}h-${cell}z`);
  }

  return (
    <svg
      className="identity-sigil"
      viewBox="0 0 100 100"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? identity.description : undefined}
      aria-hidden={labelled ? undefined : true}
      style={{ color: identity.accent.hex }}
    >
      <path d={squares.join('')} fill="currentColor" shapeRendering="crispEdges" />
    </svg>
  );
}
