import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerRoutes } from './api/routes.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { startMcpHttpServer } from './mcp/http.js';

async function main(): Promise<void> {
  // Fail fast with a clear message if the database isn't reachable yet,
  // rather than surfacing confusing errors from the first request.
  await pool.query('SELECT 1');

  const app = Fastify({ logger: true });

  // Fastify's default JSON parser 400s on a request that declares
  // `Content-Type: application/json` but sends no body (e.g. a DELETE with
  // that header set out of habit) - treat an empty body as "no body" rather
  // than a parse error, since plenty of HTTP clients set the header
  // unconditionally regardless of method.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Every route validates its body/query with a Zod schema by calling
  // .parse() directly, which throws a ZodError on invalid input. Without
  // this handler that error falls through as an opaque 500 - map it to a
  // 400 with the actual validation message instead.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
      return;
    }
    app.log.error(error);
    reply.code(500).send({ error: 'Internal server error' });
  });

  await app.register(cors, { origin: config.corsOrigins });
  await registerRoutes(app);

  await app.listen({ host: '0.0.0.0', port: config.apiPort });
  app.log.info(`REST API listening on :${config.apiPort}`);

  startMcpHttpServer();

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
