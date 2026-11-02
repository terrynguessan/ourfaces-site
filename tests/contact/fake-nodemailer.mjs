// Stand-in for nodemailer in the contact API tests: records what the route
// asks for and never opens a network connection.

export const calls = { transports: [], mails: [], failNext: false };

export function resetMailer() {
  calls.transports.length = 0;
  calls.mails.length = 0;
  calls.failNext = false;
}

export default {
  createTransport(options) {
    calls.transports.push(options);
    return {
      async sendMail(message) {
        if (calls.failNext) {
          calls.failNext = false;
          throw new Error(
            `Invalid login: 535 Authentication Failed for ${options.auth.user}`,
          );
        }
        calls.mails.push(message);
        return { messageId: "<test@example.invalid>" };
      },
    };
  },
};
