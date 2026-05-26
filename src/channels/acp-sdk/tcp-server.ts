import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { createLogger } from '../../logger.js';
import { CopilotAgent } from './copilot-agent.js';

const log = createLogger('acp-tcp');

export interface AcpTcpServerOptions {
  bind: string;
  port: number;
  agentName: string;
  botCfg: AcpBotConfig;
}

export interface AcpTcpServer {
  port: number;
  agentName: string;
  close(): Promise<void>;
}

export async function createAcpTcpServer(
  opts: AcpTcpServerOptions,
  bridge: CopilotBridge,
): Promise<AcpTcpServer> {
  const tcpServer: NetServer = createServer((socket: Socket) => {
    const readable = Readable.toWeb(socket) as ReadableStream<Uint8Array>;
    const writable = Writable.toWeb(socket) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    let agentRef: CopilotAgent | undefined;
    const connection = new AgentSideConnection((conn) => {
      agentRef = new CopilotAgent(conn, opts.botCfg, bridge);
      return agentRef;
    }, stream);

    connection.closed
      .then(() => agentRef?.closeAll())
      .catch((err) => log.warn('acp_tcp_closeall_error err=' + String(err)));

    socket.on('error', (err) => log.error('acp_tcp_socket_error err=' + String(err)));
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    tcpServer.listen(opts.port, opts.bind, () => {
      const addr = tcpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : opts.port);
    });
    tcpServer.once('error', reject);
  });

  log.info(`acp_tcp_listening agent=${opts.agentName} addr=tcp://${opts.bind}:${boundPort}`);

  return {
    port: boundPort,
    agentName: opts.agentName,
    close(): Promise<void> {
      return new Promise((resolve, reject) =>
        tcpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
