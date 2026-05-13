import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import { registerAgentCardRoutes, type AgentCardRouteDeps } from './agent-card.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const readOnlyHeader = { authorization: 'Bearer test-secret-readonly' };
const noAgentReadHeader = { authorization: 'Bearer test-secret-noperm' };
const botAOnlyHeader = { authorization: 'Bearer test-secret-bot-a-only' };

const authConfig: AuthConfig = {
  keys: new Map([
    ['full-access', {
      secret: 'test-secret-full',
      allowedAgents: ['*'],
      allowedOps: ['*'],
    }],
    ['read-only', {
      secret: 'test-secret-readonly',
      allowedAgents: ['bot-a', 'bot-b'],
      allowedOps: ['agent:read'],
    }],
    ['no-agent-read', {
      secret: 'test-secret-noperm',
      allowedAgents: ['*'],
      allowedOps: ['card:read'],
    }],
    ['bot-a-only', {
      secret: 'test-secret-bot-a-only',
      allowedAgents: ['bot-a'],
      allowedOps: ['agent:read'],
    }],
  ]),
};

const testBots: AgentCardRouteDeps['bots'] = {
  'bot-a': { agent: 'agent-alpha', token: 'tok-a', model: 'gpt-4' },
  'bot-b': { agent: 'agent-beta', token: 'tok-b' },
  'bot-c': { token: 'tok-c' },
};

const cardDeps: AgentCardRouteDeps = {
  bots: testBots,
  publicBaseUrl: 'http://test.local',
  bridgeVersion: '9.9.9',
};

describe('registerAgentCardRoutes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerAgentCardRoutes(app, cardDeps);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /agents/:name/.well-known/agent-card.json', () => {
    it('returns 200 and AgentCard JSON with full-access auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/agents/bot-a/.well-known/agent-card.json',
        headers: readOnlyHeader,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        name: 'bot-a',
        description: 'copilot-bridge agent: agent-alpha',
        version: '9.9.9',
        supportedInterfaces: [
          {
            url: 'http://test.local/v1',
            protocolBinding: 'HTTP+JSON',
            protocolVersion: '0.3',
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
        securitySchemes: {
          bridge_api_key: {
            httpAuthSecurityScheme: {
              scheme: 'Bearer',
              description: 'copilot-bridge API key configured per client.',
            },
          },
        },
        securityRequirements: [{ bridge_api_key: [] }],
      });
    });

    it('returns body with requested bot name', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/agents/bot-a/.well-known/agent-card.json',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ name: string }>().name).toBe('bot-a');
    });

    it('uses publicBaseUrl for supported interface URL', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/agents/bot-a/.well-known/agent-card.json',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ supportedInterfaces: Array<{ url: string }> }>().supportedInterfaces[0].url).toBe('http://test.local/v1');
    });

    it('strips trailing slash from publicBaseUrl for supported interface URL', async () => {
      await app.close();
      app = Fastify({ logger: false });
      registerAuthHook(app, authConfig);
      registerAgentCardRoutes(app, { ...cardDeps, publicBaseUrl: 'http://test.local/' });

      const response = await app.inject({
        method: 'GET',
        url: '/agents/bot-a/.well-known/agent-card.json',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ supportedInterfaces: Array<{ url: string }> }>().supportedInterfaces[0].url).toBe('http://test.local/v1');
    });

    it('uses bridgeVersion for version', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/agents/bot-a/.well-known/agent-card.json',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ version: string }>().version).toBe('9.9.9');
    });

    it('returns 404 for unknown agent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/agents/nonexistent/.well-known/agent-card.json',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Agent not found' });
    });

    it('returns 403 when API key lacks agent:read permission', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/agents/bot-a/.well-known/agent-card.json',
        headers: noAgentReadHeader,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns 403 when API key cannot access the requested agent', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/agents/bot-b/.well-known/agent-card.json',
        headers: botAOnlyHeader,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns 401 when no API key is present', async () => {
      const response = await app.inject({ method: 'GET', url: '/agents/bot-a/.well-known/agent-card.json' });

      expect(response.statusCode).toBe(401);
    });
  });
});
