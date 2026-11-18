// src/lib/mailer.js — sends patient login codes by email (free with a Gmail app password)
import nodemailer from 'nodemailer';
import { config } from '../config.js';

export const emailConfigured = () => Boolean(config.smtp.user && config.smtp.pass);

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transport;
}

/** Send the code. Without SMTP settings (development), print it in the server window instead. */
export async function sendLoginCode(to, code, clinicName) {
  if (!emailConfigured()) {
    console.log(`[patient-login] DEV MODE (no SMTP set): code for ${to} is ${code}`);
    return { dev: true };
  }
  await getTransport().sendMail({
    from: `"${clinicName}" <${config.smtp.from}>`,
    to,
    subject: `${code} is your ${clinicName} login code`,
    text: `Your ${clinicName} patient portal login code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    html: `<p>Your <b>${clinicName}</b> patient portal login code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't ask for it, ignore this email.</p>`,
  });
  return { dev: false };
}

export async function sendTestEmail(to) {
  await getTransport().sendMail({
    from: `"CityCare" <${config.smtp.from}>`, to,
    subject: 'CityCare: email is working',
    text: 'Patient login codes will be sent from this address.',
  });
}

export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}
