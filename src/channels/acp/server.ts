import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { AcpConnectionHandler } from './connection-handler.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { createLogger } from '../../logger.js';
import type { AgentCard } from './agent-card-types.js';

const log = createLogger('acp-server');

function buildAgentCard(
  name: string,
  bot: AcpBotConfig,
  acpWsUrl: string,
  bridgeVersion: string,
): AgentCard {
  return {
    name,
    description: `copilot-bridge agent: ${bot.agent ?? name}`,
    version: bridgeVersion,
    supportedInterfaces: [
      {
        url: `${acpWsUrl}/${name}`,
        protocolBinding: 'ACP+WS',
        protocolVersion: '1',
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'chat',
        name: 'Chat',
        description: 'Conversational chat with the underlying Copilot agent.',
        tags: ['chat', 'copilot'],
      },
    ],
  };
}

export interface AcpServerOptions {
  bind: string;
  port: number;
  bots: Record<string, AcpBotConfig>;
  bridgeVersion: string;
}

export interface AcpServer {
  close(): Promise<void>;
  port: number;
}

export async function createAcpServer(opts: AcpServerOptions, bridge: CopilotBridge): Promise<AcpServer> {
  let acpWsUrl = `ws://${opts.bind}:${opts.port}`;

  const httpServer: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/v1/agents/cards') {
      const cards = Object.entries(opts.bots).map(([name, bot]) =>
        buildAgentCard(name, bot, acpWsUrl, opts.bridgeVersion),
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cards }));
      return;
    }

    const cardMatch = pathname.match(/^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/);
    if (req.method === 'GET' && cardMatch) {
      const name = decodeURIComponent(cardMatch[1]);
      const bot = opts.bots[name];
      if (!bot) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildAgentCard(name, bot, acpWsUrl, opts.bridgeVersion)));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('ACP WebSocket server - use ws:// protocol');
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? 'localhost')).pathname;
    const botName = pathname.slice(1);
    const botCfg = opts.bots[botName];

    if (!botCfg) {
      log.warn('ACP: unknown bot "' + botName + '", rejecting upgrade');
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (botCfg.token) {
      const authHeader = request.headers['authorization'] ?? '';
      if (authHeader !== 'Bearer ' + botCfg.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, botCfg);
    });
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, botCfg: AcpBotConfig) => {
    const handler = new AcpConnectionHandler(botCfg, bridge, (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });

    ws.on('message', (data) => {
      handler.handle(data.toString()).catch((err) => {
        log.error('ACP handler error', { err });
      });
    });

    ws.on('close', () => {
      handler.closeAll().catch((err) => {
        log.error('ACP closeAll error', { err });
      });
    });

    ws.on('error', (err) => {
      log.error('ACP WebSocket error', { err });
    });
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    httpServer.listen(opts.port, opts.bind, () => {
      const addr = httpServer.address() as AddressInfo;
      resolve(addr.port);
    });
    httpServer.once('error', reject);
  });
  acpWsUrl = `ws://${opts.bind}:${boundPort}`;

  log.info('ACP server listening on ws://' + opts.bind + ':' + boundPort);

  return {
    port: boundPort,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        wss.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
