import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import type { AgentCard } from '../agent-card-types.js';
import {
  buildAgentCard,
  registerAgentCardCatalogRoute,
  type AgentCardRouteDeps,
} from './agent-card.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const readOnlyHeader = { authorization: 'Bearer test-secret-readonly' };
const noAgentReadHeader = { authorization: 'Bearer test-secret-noperm' };

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

describe('registerAgentCardCatalogRoute', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerAgentCardCatalogRoute(app, cardDeps);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /v1/agents/cards', () => {
    it('returns 200 and AgentCard JSON array with full-access auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/cards',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ cards: AgentCard[] }>();
      expect(Array.isArray(body.cards)).toBe(true);
      expect(body.cards[0]).toHaveProperty('name');
      expect(body.cards[0]).toHaveProperty('version');
      expect(body.cards[0]).toHaveProperty('supportedInterfaces');
    });

    it('returns all three cards with full-access auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/cards',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ cards: AgentCard[] }>().cards).toHaveLength(3);
    });

    it('filters cards to allowed agents for read-only key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/cards',
        headers: readOnlyHeader,
      });

      expect(response.statusCode).toBe(200);
      const cards = response.json<{ cards: AgentCard[] }>().cards;
      expect(cards).toHaveLength(2);
      expect(cards.map((card) => card.name)).toEqual(expect.arrayContaining(['bot-a', 'bot-b']));
      expect(cards.map((card) => card.name)).not.toContain('bot-c');
    });

    it('returns cards with the buildAgentCard shape', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/cards',
        headers: fullAccessHeader,
      });

      expect(response.statusCode).toBe(200);
      const cards = response.json<{ cards: AgentCard[] }>().cards;
      const botA = cards.find((card) => card.name === 'bot-a');
      expect(botA).toEqual(buildAgentCard('bot-a', testBots['bot-a'], cardDeps));
      expect(botA?.name).toBe('bot-a');
      expect(botA?.version).toBe('9.9.9');
      expect(botA?.supportedInterfaces[0].url).toBe('http://test.local/v1');
    });

    it('returns 403 when API key lacks agent:read permission', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/agents/cards',
        headers: noAgentReadHeader,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });

    it('returns 401 when no API key is present', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/agents/cards' });

      expect(response.statusCode).toBe(401);
    });
  });
});
