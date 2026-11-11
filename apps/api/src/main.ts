import 'reflect-metadata';
import { createApp } from './app.js';

const DEFAULT_PORT = 4000;

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.API_PORT ?? DEFAULT_PORT);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
