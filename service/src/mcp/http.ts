import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { createInvestmentDashboardMcpServer } from './server.js';

const transports = new Map<string, StreamableHTTPServerTransport>();

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Starts the MCP server on its own HTTP listener (Streamable HTTP transport,
 * MCP spec 2025-03-26+), separate from the REST API. Point a Claude session
 * (e.g. your weekly research scheduled task) at `http://<host>:<mcpPort>/mcp`
 * with `Authorization: Bearer <API_KEY>`.
 *
 * One MCP server + transport pair is created per session; the SDK issues a
 * session id on the first (initialize) request and every subsequent request
 * from that client carries it back in the `Mcp-Session-Id` header so we can
 * route to the right transport.
 */
export function startMcpHttpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    if (token !== config.apiKey) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        const mcpServer = createInvestmentDashboardMcpServer();
        const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            transports.set(newId, newTransport);
          },
          onsessionclosed: (closedId) => {
            transports.delete(closedId);
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) transports.delete(newTransport.sessionId);
        };
        await mcpServer.connect(newTransport);
        transport = newTransport;
      }

      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[mcp] request error:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  });

  server.listen(config.mcpPort, () => {
    console.log(`[mcp] listening on :${config.mcpPort}/mcp`);
  });

  return server;
}
