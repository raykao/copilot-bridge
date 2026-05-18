import type { FastifyInstance } from 'fastify';
import type { BotConfig } from '../../../types.js';
import type { AgentCard } from '../agent-card-types.js';
import { canAccessAgent, canPerformOp } from '../auth.js';

interface AgentCardBotConfig extends Pick<BotConfig, 'agent' | 'token'> {
  model?: string;
}

export interface AgentCardRouteDeps {
  bots: Record<string, AgentCardBotConfig>;
  // Public base URL of this bridge (e.g. "https://bridge.example.com").
  // Used to build absolute URLs in supportedInterfaces.
  publicBaseUrl: string;
  // Bridge package version (read from package.json by caller).
  bridgeVersion: string;
  // Optional ACP WebSocket base URL, e.g. "ws://localhost:3030".
  // When present, each agent card includes an ACP+WS interface entry.
  // Kanban appends "/<agentName>" to construct the per-agent WS URL.
  acpWsUrl?: string;
}

const DEFAULT_INPUT_MODES = ['text/plain'];
const DEFAULT_OUTPUT_MODES = ['text/plain'];

export function registerAgentCardRoutes(app: FastifyInstance, deps: AgentCardRouteDeps): void {
  app.get<{ Params: { name: string } }>(
    '/agents/:name/.well-known/agent-card.json',
    async (request, reply) => {
      if (!request.apiKey || !canPerformOp(request.apiKey, 'agent:read')) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const { name } = request.params;
      const bot = deps.bots[name];

      if (!bot) {
        return reply.status(404).send({ error: 'Agent not found' });
      }
      if (!canAccessAgent(request.apiKey!, name)) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      return buildAgentCard(name, bot, deps);
    },
  );
}

export function registerAgentCardCatalogRoute(app: FastifyInstance, deps: AgentCardRouteDeps): void {
  app.get('/v1/agents/cards', async (request, reply) => {
    if (!request.apiKey || !canPerformOp(request.apiKey, 'agent:read')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const cards = Object.entries(deps.bots)
      .filter(([name]) => canAccessAgent(request.apiKey!, name))
      .map(([name, bot]) => buildAgentCard(name, bot, deps));

    return { cards };
  });
}

export function buildAgentCard(
  name: string,
  bot: AgentCardBotConfig,
  deps: Pick<AgentCardRouteDeps, 'publicBaseUrl' | 'bridgeVersion' | 'acpWsUrl'>,
): AgentCard {
  const baseUrl = deps.publicBaseUrl.replace(/\/+$/, '');
  return {
    name,
    description: `copilot-bridge agent: ${bot.agent ?? name}`,
    version: deps.bridgeVersion,
    supportedInterfaces: [
      {
        url: `${baseUrl}/v1`,
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '0.3',
      },
      ...(deps.acpWsUrl
        ? [
            {
              url: `${deps.acpWsUrl}/${name}`,
              protocolBinding: 'ACP+WS',
              protocolVersion: '1',
            },
          ]
        : []),
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: DEFAULT_INPUT_MODES,
    defaultOutputModes: DEFAULT_OUTPUT_MODES,
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
  };
}
