import { pathToFileURL } from 'node:url';
import { createGameServer } from './createGameServer';

async function main() {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const server = await createGameServer({
    // Render and most managed web-service hosts inject PORT. Keep WS_PORT as
    // the explicit local/self-hosted override used by the existing setup.
    port: Number(process.env.WS_PORT ?? process.env.PORT ?? 3001),
    allowedOrigins,
  });
  console.log(`Gridline WebSocket authority listening on ws://localhost:${server.port}/ws`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Failed to start the Gridline server:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
