import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ApplicationError } from './framework/core/errors.js';
import { createApplication } from './framework/composition/create-application.js';
import { registerInfrastructure } from './plugins/infrastructure.js';
import { authenticationSettings, registerAuthentication, SESSION_COOKIE } from './middlewares/authentication.js';
import type { AuthenticationOptions } from './middlewares/authentication.js';
import { registerClient } from './plugins/client.js';
import { registerDomainRoutes } from './framework/composition/register-domain-routes.js';
import { registerSystemRoutes } from './plugins/system-routes.js';

export type ApplicationOptions = {
  databaseUrl: string;
  auth: AuthenticationOptions;
  logger?: boolean;
};

export async function buildServer(options: ApplicationOptions) {
  const authentication = authenticationSettings(options.auth);
  const server = Fastify({
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
    bodyLimit: 16_384,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  try {
    server.setErrorHandler<FastifyError>((error, request, reply) => {
      if (error instanceof ApplicationError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, requestId: request.id } });
      }
      if (error.validation || (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)) {
        return reply.code(error.statusCode ?? 400).send({ error: { code: 'INVALID_REQUEST', message: error.validation ? 'Проверьте формат полей запроса.' : error.message, requestId: request.id } });
      }
      request.log.error(error);
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось выполнить операцию.', requestId: request.id } });
    });
    await server.register(swagger, {
      openapi: {
        info: { title: 'job-autopilot API', version: '0.1.0', description: 'Сбор вакансий, отбор и подача откликов.' },
        components: { securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        } },
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      },
    });
    await server.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        requestInterceptor: (request) => {
          request.headers = { ...request.headers, 'X-Requested-With': 'XMLHttpRequest' };
          return request;
        },
      },
    });

    const infrastructure = await registerInfrastructure(server, options.databaseUrl);
    const application = createApplication(infrastructure.prisma, infrastructure.clock, infrastructure.identifiers, authentication.sessionTtlSeconds);
    await registerAuthentication(server, application.users, authentication);
    registerDomainRoutes(server, application, { name: SESSION_COOKIE, secure: authentication.cookieSecure });
    registerSystemRoutes(server, infrastructure.checkDatabase);
    await registerClient(server);
    await server.ready();
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}
