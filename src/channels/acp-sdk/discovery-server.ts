import { createServer, type Server as HttpServer } from 'node:http';
import { createLogger } from '../../logger.js';

const log = createLogger('acp-discovery');

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  workingDirectory: string;
  protocol: 'acp';
  transport: 'tcp';
  port: number;
}

export interface DiscoveryServerOptions {
  bind: string;
  port: number;
  cards: AgentCard[];
}

export interface DiscoveryServer {
  port: number;
  close(): Promise<void>;
}

export async function createDiscoveryServer(
  opts: DiscoveryServerOptions,
): Promise<DiscoveryServer> {
  const server: HttpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/agents/cards') {
      const body = JSON.stringify(opts.cards, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.listen(opts.port, opts.bind, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : opts.port);
    });
    server.once('error', reject);
  });

  log.info(`acp_discovery_listening addr=http://${opts.bind}:${boundPort}/v1/agents/cards cards=${opts.cards.length}`);

  return {
    port: boundPort,
    close(): Promise<void> {
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
