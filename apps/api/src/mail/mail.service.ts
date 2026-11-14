import nodemailer from 'nodemailer';

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends e-mail. Replaced by an in-memory fake in tests. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/**
 * SMTP transport (RID_SMTP_URL; Mailpit in development). Only workers send mail, from the outbox,
 * so a message goes out if and only if the change that caused it committed.
 */
export function createSmtpTransport(): MailTransport {
  const transport = nodemailer.createTransport(process.env.RID_SMTP_URL ?? 'smtp://localhost:1025');
  const from = process.env.RID_MAIL_FROM ?? 'Portal RID <no-reply@rid.example>';
  return {
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}
