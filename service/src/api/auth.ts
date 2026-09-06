import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/** Simple shared-bearer-token auth. Fine for a single-user deployment; swap for something richer if this ever grows multi-user. */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token !== config.apiKey) {
    await reply.code(401).send({ error: 'Unauthorized' });
  }
}
