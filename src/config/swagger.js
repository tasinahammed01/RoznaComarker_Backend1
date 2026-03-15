const swaggerJSDoc = require('swagger-jsdoc');

function createSwaggerSpec() {
  const baseUrl = (process.env.BASE_URL || '').trim();

  return swaggerJSDoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'RoznaComarker Backend API',
        version: '1.0.0'
      },
      servers: baseUrl
        ? [{ url: baseUrl }]
        : [{ url: 'http://82.112.234.151:5000' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      }
    },
    apis: ['src/routes/*.routes.js']
  });
}

module.exports = {
  createSwaggerSpec
};
