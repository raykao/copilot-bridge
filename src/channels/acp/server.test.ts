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

interface AgentCardTestShape {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: string;
    protocolVersion: string;
  }>;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
}

interface AgentCardsResponseTestShape {
  cards: AgentCardTestShape[];
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
    fakeBridge = { createSession: async () => fakeSession, getOrCreateBotSession: async () => fakeSession, forceResumeSession: async () => fakeSession } as unknown as CopilotBridge;
    server = await createAcpServer({
      bind: '127.0.0.1',
      port: 0,
      bots: { bob: { agent: 'bob', model: 'claude-sonnet-4.6', workingDirectory: '/tmp/test' } },
      bridgeVersion: '0.0.0-test',
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

  it('GET /v1/agents/cards returns { cards: [...] } with one card per bot', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/cards`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as AgentCardsResponseTestShape;
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]).toMatchObject({
      name: 'bob',
      description: 'copilot-bridge agent: bob',
      version: '0.0.0-test',
      capabilities: { streaming: true, pushNotifications: false },
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
    });
    const acp = body.cards[0].supportedInterfaces.find((i) => i.protocolBinding === 'ACP+WS');
    expect(acp).toEqual({
      url: `ws://127.0.0.1:${port}/bob`,
      protocolBinding: 'ACP+WS',
      protocolVersion: '1',
    });
  });

  it('GET /agents/:name/.well-known/agent-card.json returns the agent card', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/agents/bob/.well-known/agent-card.json`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as AgentCardTestShape;
    expect(body).toMatchObject({
      name: 'bob',
      description: 'copilot-bridge agent: bob',
      version: '0.0.0-test',
    });
    expect(body.supportedInterfaces).toContainEqual({
      url: `ws://127.0.0.1:${port}/bob`,
      protocolBinding: 'ACP+WS',
      protocolVersion: '1',
    });
  });

  it('GET /agents/unknown/.well-known/agent-card.json returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/agents/unknown/.well-known/agent-card.json`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Agent not found' });
  });

  it('GET /unknown/path returns 404 text/plain', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown/path`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('ACP WebSocket server - use ws:// protocol');
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
      bridgeVersion: '0.0.0-test',
    }, fakeBridge);
    try {
      const ws = new WebSocket('ws://127.0.0.1:' + tokenServer.port + '/bob');

      await waitForRejectedConnection(ws);
    } finally {
      await tokenServer.close();
    }
  });
});
