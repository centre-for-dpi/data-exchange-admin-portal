import { assertNoExampleSecrets, isDeployed } from '@den/config';
import { createTransport } from 'nodemailer';
import { configFromEnv, developmentTsaTrust, loadRootEnv } from './config.js';
import { buildServer } from './server.js';
import { AlertStore } from './store.js';

loadRootEnv();
// M-25: deployed, its two secrets cannot keep the public values of .env.example.
try {
  assertNoExampleSecrets(['DEN_CITIZEN_APP_CLIENT_SECRET', 'CITIZEN_APP_WEBHOOK_SECRET'], {
    production: isDeployed(process.env.DEN_CITIZEN_APP_URL),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const config = configFromEnv();
const transport = createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: false,
  ignoreTLS: true,
});
const app = buildServer(config, {
  store: new AlertStore(config.dataFile),
  mailer: {
    async send(message) {
      await transport.sendMail({ from: config.smtp.from, ...message });
    },
  },
});
// In production, receipts checked against the development TSA prove less than they say (M-14).
const tsaTrust = developmentTsaTrust(config);
if (tsaTrust && process.env.NODE_ENV === 'production') {
  app.log.error(`!!! Receipts are checked against the development TSA: ${tsaTrust} !!!`);
}
app.listen({ port: config.port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
