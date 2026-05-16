import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createAcpServer, type AcpServer } from './server.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { CopilotSession } from '@github/copilot-sdk';

interface JsonRpcMessage {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function waitForRejectedConnection(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('error', () => resolve());
    ws.once('unexpected-response', () => resolve());
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as JsonRpcMessage);
      } catch (err) {
        reject(err);
      }
    });
    ws.once('error', reject);
  });
}

async function sendAndWait(ws: WebSocket, msg: JsonRpcMessage): Promise<JsonRpcMessage> {
  const responsePromise = waitForMessage(ws);
  ws.send(JSON.stringify(msg));
  return responsePromise;
}

describe('createAcpServer', () => {
  let server: AcpServer;
  let port: number;
  let fakeBridge: CopilotBridge;

  beforeEach(async () => {
    const fakeSession = {
      sessionId: 'ws-test-sid',
      on: () => () => {},
      send: async () => 'msg-id',
      abort: async () => {},
      disconnect: async () => {},
    } as unknown as CopilotSession;
    fakeBridge = { createSession: async () => fakeSession } as unknown as CopilotBridge;
    server = await createAcpServer({
      bind: '127.0.0.1',
      port: 0,
      bots: { bob: { agent: 'bob', model: 'claude-sonnet-4.6', workingDirectory: '/tmp/test' } },
    }, fakeBridge);
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
  });

  it('rejects unknown bot path', async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/unknown');

    await waitForRejectedConnection(ws);
  });

  it('performs initialize handshake', async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/bob');
    await waitForOpen(ws);

    const response = await sendAndWait(ws, {
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: { protocolVersion: '0.3', clientCapabilities: {} },
    });
    ws.close();

    expect(response).toMatchObject({
      id: 1,
      result: { protocolVersion: '0.3', agentCapabilities: {}, authMethods: [] },
    });
  });

  it('session/new returns sessionId', async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/bob');
    await waitForOpen(ws);

    await sendAndWait(ws, {
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: { protocolVersion: '0.3', clientCapabilities: {} },
    });
    const response = await sendAndWait(ws, {
      jsonrpc: '2.0',
      method: 'session/new',
      id: 2,
      params: {},
    });
    ws.close();

    expect(response).toMatchObject({
      id: 2,
      result: { sessionId: 'ws-test-sid' },
    });
  });

  it('rejects missing bearer token', async () => {
    const tokenServer = await createAcpServer({
      bind: '127.0.0.1',
      port: 0,
      bots: { bob: { agent: 'bob', model: 'claude-sonnet-4.6', workingDirectory: '/tmp/test', token: 'secret' } },
    }, fakeBridge);
    try {
      const ws = new WebSocket('ws://127.0.0.1:' + tokenServer.port + '/bob');

      await waitForRejectedConnection(ws);
    } finally {
      await tokenServer.close();
    }
  });
});
