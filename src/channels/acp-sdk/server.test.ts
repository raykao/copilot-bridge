import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAcpSdkServer, type AcpSdkServer } from './server.js';
import type { CopilotBridge } from '../../core/bridge.js';

interface AgentCardTestShape {
  name: string;
  description: string;
}

interface AgentCardsResponseTestShape {
  cards: AgentCardTestShape[];
}

const mockBridge = {} as CopilotBridge;

function waitForRejectedConnection(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('error', () => resolve());
    ws.once('close', () => resolve());
    ws.once('unexpected-response', () => resolve());
  });
}

describe('createAcpSdkServer', () => {
  it('createAcpSdkServer starts and returns a port', async () => {
    const server = await createAcpSdkServer({
      bind: '127.0.0.1',
      port: 0,
      bots: { testbot: {} },
      bridgeVersion: '0.16.1',
    }, mockBridge);

    try {
      expect(server.port).toBeTypeOf('number');
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('GET /v1/agents/cards returns bot names', async () => {
    const server: AcpSdkServer = await createAcpSdkServer({
      bind: '127.0.0.1',
      port: 0,
      bots: { alice: {}, bob: {} },
      bridgeVersion: '0.16.1',
    }, mockBridge);

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/agents/cards`);
      const body = await response.json() as AgentCardsResponseTestShape;

      expect(body.cards.some((card) => card.name === 'alice')).toBe(true);
      expect(body.cards.some((card) => card.name === 'bob')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('WS upgrade to unknown bot returns 404', async () => {
    const server = await createAcpSdkServer({
      bind: '127.0.0.1',
      port: 0,
      bots: { alice: {} },
      bridgeVersion: '0.16.1',
    }, mockBridge);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/nonexistent`);
      await waitForRejectedConnection(ws);
    } finally {
      await server.close();
    }
  });
});
