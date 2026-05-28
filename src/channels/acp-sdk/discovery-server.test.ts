import { describe, it, expect, afterEach } from 'vitest';
import { createDiscoveryServer } from './discovery-server.js';
import type { AgentCard } from './discovery-server.js';

describe('createDiscoveryServer', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  const sampleCards: AgentCard[] = [
    {
      name: 'bob',
      description: 'Copilot Bridge ACP agent: bob',
      url: 'tcp://127.0.0.1:4000',
      workingDirectory: '/home/raykao/.copilot-bridge/workspaces/bob',
      protocol: 'acp',
      transport: 'tcp',
      port: 4000,
    },
  ];

  it('returns 200 with agent cards array on GET /v1/agents/cards', async () => {
    const srv = await createDiscoveryServer({ bind: '127.0.0.1', port: 0, cards: sampleCards });
    servers.push(srv);

    const res = await fetch(`http://127.0.0.1:${srv.port}/v1/agents/cards`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as AgentCard[];
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('bob');
    expect(body[0].protocol).toBe('acp');
    expect(body[0].transport).toBe('tcp');
    expect(body[0].workingDirectory).toBe('/home/raykao/.copilot-bridge/workspaces/bob');
  });

  it('returns 404 for unknown paths', async () => {
    const srv = await createDiscoveryServer({ bind: '127.0.0.1', port: 0, cards: sampleCards });
    servers.push(srv);

    const res = await fetch(`http://127.0.0.1:${srv.port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns empty array when no agents configured', async () => {
    const srv = await createDiscoveryServer({ bind: '127.0.0.1', port: 0, cards: [] });
    servers.push(srv);

    const res = await fetch(`http://127.0.0.1:${srv.port}/v1/agents/cards`);
    const body = await res.json() as AgentCard[];
    expect(body).toEqual([]);
  });
});
