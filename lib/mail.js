import nodemailer from 'nodemailer';

// One transport per process. In development without SMTP_HOST configured the
// code is printed to the server console instead of being emailed.
export function createMailer(config, logger = console) {
  if (!config.smtpConfigured) {
    if (config.isProduction) {
      // Not a startup failure: most businesses never ask for an email, so a
      // production install without SMTP is perfectly normal. Only a business
      // with email verification switched on needs it, and it finds out here.
      return {
        mode: 'unavailable',
        async sendLoginCode() {
          throw new Error(
            'This business asks reviewers to verify an email, but SMTP_HOST is not configured.',
          );
        },
      };
    }
    return {
      mode: 'console',
      async sendLoginCode(email, code) {
        logger.log(`\n  ReviewQR login code for ${email}: ${code}  (expires in 10 minutes)\n`);
        return { delivered: false, mode: 'console' };
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });

  return {
    mode: 'smtp',
    async sendLoginCode(email, code) {
      await transport.sendMail({
        from: config.smtp.from,
        to: email,
        subject: `Your ReviewQR code: ${code}`,
        text: [
          `Your ReviewQR sign-in code is ${code}.`,
          '',
          'It expires in 10 minutes and can only be used once.',
          'If you did not ask for this code, you can ignore this email.',
        ].join('\n'),
      });
      return { delivered: true, mode: 'smtp' };
    },
  };
}
