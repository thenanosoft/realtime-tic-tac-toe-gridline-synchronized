import type { RejectionCode } from '../shared/protocol';

export class CommandError extends Error {
  constructor(
    public readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}
