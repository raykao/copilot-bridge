import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import type { SessionEvent } from '@github/copilot-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CopilotBridge } from '../../core/bridge.js';
import { createAcpTcpServer, type AcpTcpServer } from './tcp-server.js';

const servers: AcpTcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function makeMockBridge() {
  const mockSession = {
    sessionId: 'tcp-test-sess-1',
    on: vi.fn((cb: (e: SessionEvent) => void) => {
      setTimeout(() => cb({ type: 'session.idle' } as SessionEvent), 10);
      return () => {};
    }),
    send: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  return {
    bridge: { createSession: vi.fn().mockResolvedValue(mockSession) } as unknown as CopilotBridge,
    mockSession,
  };
}

function makeClient(port: number): Promise<{ conn: ClientSideConnection; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const readable = Readable.toWeb(socket) as ReadableStream<Uint8Array>;
      const writable = Writable.toWeb(socket) as WritableStream<Uint8Array>;
      const stream = ndJsonStream(writable, readable);
      const mockClient: Client = {
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
        requestPermission: vi.fn().mockResolvedValue({ outcome: { outcome: 'cancelled' } }),
      };
      const conn = new ClientSideConnection((_agent) => mockClient, stream);
      resolve({ conn, socket });
    });
    socket.once('error', reject);
  });
}

describe('createAcpTcpServer', () => {
  it('starts and returns a port greater than 0', async () => {
    const { bridge } = makeMockBridge();
    const server = await createAcpTcpServer(
      { bind: '127.0.0.1', port: 0, agentName: 'testbot', botCfg: {} },
      bridge,
    );
    servers.push(server);
    expect(server.port).toBeTypeOf('number');
    expect(server.port).toBeGreaterThan(0);
    expect(server.agentName).toBe('testbot');
  });

  it('accepts a TCP connection and completes ACP initialize round-trip', async () => {
    const { bridge } = makeMockBridge();
    const server = await createAcpTcpServer(
      { bind: '127.0.0.1', port: 0, agentName: 'bob', botCfg: { agent: 'bob' } },
      bridge,
    );
    servers.push(server);

    const { conn, socket } = await makeClient(server.port);
    try {
      const initRes = await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(initRes.protocolVersion).toBe(PROTOCOL_VERSION);
    } finally {
      socket.destroy();
    }
  });

  it('completes full initialize -> newSession -> prompt round-trip over TCP', async () => {
    const { bridge, mockSession } = makeMockBridge();
    const server = await createAcpTcpServer(
      { bind: '127.0.0.1', port: 0, agentName: 'bob', botCfg: { agent: 'bob' } },
      bridge,
    );
    servers.push(server);

    const { conn, socket } = await makeClient(server.port);
    try {
      await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const sessionRes = await conn.newSession({ cwd: '/tmp', mcpServers: [] });
      expect(sessionRes.sessionId).toBe('tcp-test-sess-1');

      const promptRes = await conn.prompt({
        sessionId: sessionRes.sessionId,
        prompt: [{ type: 'text', text: 'hello tcp' }],
      });
      expect(promptRes.stopReason).toBe('end_turn');
      expect(mockSession.send).toHaveBeenCalledWith({ prompt: 'hello tcp' });
    } finally {
      socket.destroy();
    }
  });

  it('handles multiple simultaneous connections to the same server', async () => {
    const { bridge } = makeMockBridge();
    const server = await createAcpTcpServer(
      { bind: '127.0.0.1', port: 0, agentName: 'bob', botCfg: { agent: 'bob' } },
      bridge,
    );
    servers.push(server);

    const [c1, c2] = await Promise.all([makeClient(server.port), makeClient(server.port)]);
    try {
      const [r1, r2] = await Promise.all([
        c1.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
        c2.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      ]);
      expect(r1.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(r2.protocolVersion).toBe(PROTOCOL_VERSION);
    } finally {
      c1.socket.destroy();
      c2.socket.destroy();
    }
  });
});
