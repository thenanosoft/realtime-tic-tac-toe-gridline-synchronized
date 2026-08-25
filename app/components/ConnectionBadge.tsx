import type { ConnectionState } from '../hooks/useGameSocket';

const labels: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <div className={`connection-badge connection-${state}`} role="status" aria-label={`WebSocket ${labels[state]}`}>
      <span className="connection-icon" aria-hidden="true"><i /></span>
      <span>{labels[state]}</span>
    </div>
  );
}
