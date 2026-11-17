import { parseProvider } from './providers.js';
import { assertionFromEnv, buildServer } from './server.js';

const DEFAULT_PORT = 8000;

const provider = parseProvider(process.env.PROVIDER);
const app = buildServer(provider, { assertion: assertionFromEnv(provider) });
const port = Number(process.env.PORT ?? DEFAULT_PORT);

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
