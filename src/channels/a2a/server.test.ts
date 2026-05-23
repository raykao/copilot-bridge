import { describe, it, expect, beforeEach } from 'vitest';
import { A2AServer } from './server.js';
import type { A2APlatformConfig } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { Hono } from 'hono';

describe('A2AServer routing', () => {
  let server: A2AServer;
  let app: Hono;

  beforeEach(() => {
    const config: A2APlatformConfig = {
      enabled: true,
      port: 0,
      bots: { copilot: { token: 'bot-tok', agent: 'copilot' } },
      apiKeys: { 'dev-key': { secret: 'test-secret', allowedAgents: ['*'] } },
    };
    const bridge = {} as CopilotBridge;
    server = new A2AServer(config, bridge);
    app = server.getApp();
  });

  it('GET /healthz returns 200 without auth', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.protocol).toBe('a2a');
  });

  it('GET /agents/unknown/.well-known/agent-card.json returns 404', async () => {
    const res = await app.request('/agents/unknown/.well-known/agent-card.json');
    expect(res.status).toBe(404);
  });

  it('GET /agents/copilot/.well-known/agent-card.json returns AgentCard', async () => {
    const res = await app.request('/agents/copilot/.well-known/agent-card.json');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe('copilot');
    expect(body.capabilities.streaming).toBe(true);
  });

  it('GET /agents requires auth', async () => {
    const res = await app.request('/agents');
    expect(res.status).toBe(401);
  });

  it('GET /agents returns agent list with valid bearer', async () => {
    const res = await app.request('/agents', {
      headers: { Authorization: 'Bearer test-secret' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('copilot');
  });

  it('POST /agents/:name requires auth', async () => {
    const res = await app.request('/agents/copilot', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
