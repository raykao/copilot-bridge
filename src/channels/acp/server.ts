import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { AcpConnectionHandler } from './connection-handler.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('acp-server');

export interface AcpServerOptions {
  bind: string;
  port: number;
  bots: Record<string, AcpBotConfig>;
}

export interface AcpServer {
  close(): Promise<void>;
  port: number;
}

export async function createAcpServer(opts: AcpServerOptions, bridge: CopilotBridge): Promise<AcpServer> {
  const httpServer: HttpServer = createServer((req, res) => {
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
