const fs = require('fs');
const path = require('path');

describe('startup logging credential safety', () => {
  const secret = 'codexRegressionSecret_Z9y8X7w6V5u4';
  const envNames = [
    'GROQ_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'SENDGRID_API_KEY',
    'UNSPLASH_ACCESS_KEY',
  ];
  const originalEnv = {};

  beforeEach(() => {
    jest.resetModules();
    envNames.forEach((name, index) => {
      originalEnv[name] = process.env[name];
      process.env[name] = `${secret}_${index}`;
    });
  });

  afterEach(() => {
    envNames.forEach((name) => {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    });
    jest.restoreAllMocks();
  });

  test('startup imports never print a configured secret or its identifying substrings', () => {
    const captured = [];
    ['log', 'info', 'warn', 'error', 'debug'].forEach((method) => {
      jest.spyOn(console, method).mockImplementation((...args) => captured.push(args));
    });

    require('../src/services/geminiWorksheet.service');
    require('../src/services/aiGeneration.service');

    const output = captured.flat(2).map(String).join('\n');
    envNames.forEach((name, index) => {
      const configuredSecret = `${secret}_${index}`;
      expect(output).not.toContain(configuredSecret);
      expect(output).not.toContain(configuredSecret.slice(0, 8));
      expect(output).not.toContain(configuredSecret.slice(-8));
    });
    expect(output).toContain('[GROQ] configured:');
  });

  test('backend source contains no API-key prefix logging pattern', () => {
    const sourceRoot = path.resolve(__dirname, '../src');
    const files = [];
    const visit = (directory) => fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(resolved);
      else if (/\.(?:js|cjs|mjs|ts|tsx)$/.test(entry.name)) files.push(resolved);
    });
    visit(sourceRoot);

    const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/api\s*key\s*prefix/i);
    expect(source).not.toMatch(/(?:apiKey|API_KEY)[^\n]{0,120}\.(?:slice|substring)\s*\(/);
  });
});
