const dotenv = require('dotenv');

dotenv.config();

const required = ['PORT', 'MONGO_URI', 'NODE_ENV', 'JWT_SECRET'];

if (process.env.NODE_ENV === 'production') {
  required.push('FRONTEND_URL');
}
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const env = {
  PORT: Number(process.env.PORT),
  MONGO_URI: process.env.MONGO_URI,
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  FRONTEND_URL: process.env.FRONTEND_URL
};

module.exports = env;
