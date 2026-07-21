describe('email service test startup', () => {
  test('does not create or verify an SMTP transporter in NODE_ENV=test', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalKey = process.env.SENDGRID_API_KEY;
    process.env.NODE_ENV = 'test';
    process.env.SENDGRID_API_KEY = 'synthetic-sendgrid-secret';
    jest.resetModules();
    const createTransport = jest.fn(() => ({ verify: jest.fn(), sendMail: jest.fn() }));
    jest.doMock('nodemailer', () => ({ createTransport }));

    require('../src/services/emailService');

    expect(createTransport).not.toHaveBeenCalled();
    jest.dontMock('nodemailer');
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
    if (originalKey === undefined) delete process.env.SENDGRID_API_KEY; else process.env.SENDGRID_API_KEY = originalKey;
  });
});
