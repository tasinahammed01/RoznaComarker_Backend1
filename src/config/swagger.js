const swaggerJSDoc = require("swagger-jsdoc");

function createSwaggerSpec() {
  const baseUrl = (process.env.BASE_URL || "").trim();

  return swaggerJSDoc({
    definition: {
      openapi: "3.0.0",

      info: {
        title: "RoznaComarker Backend API",

        version: "1.0.0",
      },

      servers: baseUrl
        ? [{ url: baseUrl }]
        : [{ url: "https://comarkerback.roznahub.com" }],

      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",

            scheme: "bearer",

            bearerFormat: "JWT",
          },
        },
      },
    },

    apis: ["src/routes/*.routes.js"],
  });
}

module.exports = {
  createSwaggerSpec,
};
