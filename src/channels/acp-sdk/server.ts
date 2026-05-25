import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { WebSocketServer, WebSocket } from 'ws';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { createLogger } from '../../logger.js';
import { wsStream } from './ws-stream.js';
import { CopilotAgent } from './copilot-agent.js';

const log = createLogger('acp-sdk-server');

function buildAgentCard(name: string, bot: AcpBotConfig): object {
  return {
    name,
    description: `copilot-bridge agent: ${bot.agent ?? name}`,
  };
}

export interface AcpSdkServerOptions {
  bind: string;
  port: number;
  bots: Record<string, AcpBotConfig>;
  bridgeVersion: string;
}

export interface AcpSdkServer {
  close(): Promise<void>;
  port: number;
}

export async function createAcpSdkServer(opts: AcpSdkServerOptions, bridge: CopilotBridge): Promise<AcpSdkServer> {
  const httpServer: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/v1/agents/cards') {
      const cards = Object.entries(opts.bots).map(([name, bot]) =>
        buildAgentCard(name, bot),
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
      res.end(JSON.stringify(buildAgentCard(name, bot)));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('ACP WebSocket server - use ws:// protocol');
  });

  const wss = new WebSocketServer({ noServer: true });
  const pendingBots = new Map<WebSocket, AcpBotConfig>();

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
      pendingBots.set(ws, botCfg);
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage) => {
    const botCfg = pendingBots.get(ws);
    if (!botCfg) {
      log.warn('acp_sdk_no_botcfg_for_ws');
      ws.close();
      return;
    }
    pendingBots.delete(ws);

    let agentRef: CopilotAgent | undefined;
    const stream = wsStream(ws);
    const connection = new AgentSideConnection((conn) => {
      agentRef = new CopilotAgent(conn, botCfg, bridge);
      return agentRef;
    }, stream);

    connection.closed
      .then(() => agentRef?.closeAll())
      .catch((err) => log.warn('acp_sdk_closeall_error err=' + String(err)));

    ws.on('error', (err) => log.error('acp_sdk_ws_error err=' + String(err)));
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    httpServer.listen(opts.port, opts.bind, () => {
      const addr = httpServer.address() as AddressInfo;
      resolve(addr.port);
    });
    httpServer.once('error', reject);
  });
  log.info('ACP SDK server listening on ws://' + opts.bind + ':' + boundPort);

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
