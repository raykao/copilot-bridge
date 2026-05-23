import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { createLogger } from '../../logger.js';
import type { A2APlatformConfig, AgentCard } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';

const log = createLogger('a2a');

export class A2AServer {
  private app: Hono;
  private config: A2APlatformConfig;
  private bridge: CopilotBridge;
  private server: ReturnType<typeof serve> | null = null;

  constructor(config: A2APlatformConfig, bridge: CopilotBridge) {
    this.config = config;
    this.bridge = bridge;
    this.app = this.buildApp();
  }

  private buildApp(): Hono {
    const app = new Hono();

    app.get('/healthz', async (c: Context) => {
      return c.json({ status: 'ok', protocol: 'a2a', version: '1.0.0' });
    });

    const authMiddleware = async (c: any, next: any) => {
      const authHeader = c.req.header('Authorization') ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      const allowedAgents = this.resolveApiKey(token);

      if (allowedAgents === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      c.set('allowedAgents', allowedAgents);
      await next();
    };

    app.get('/agents/:name/.well-known/agent-card.json', async (c: Context) => {
      const agentName = c.req.param('name') ?? '';

      if (!agentName || !(agentName in this.config.bots)) {
        return c.json({ error: 'Not found' }, 404);
      }

      const baseUrl = new URL(c.req.url).origin;
      return c.json(this.buildAgentCard(agentName, baseUrl));
    });

    app.get('/agents', authMiddleware, async (c: Context) => {
      return c.json({
        agents: Object.keys(this.config.bots).map((name) => ({
          name,
          agentCardUrl: `/agents/${name}/.well-known/agent-card.json`,
        })),
      });
    });

    app.post('/agents/:name', authMiddleware, async (c: any) => {
      const agentName = c.req.param('name');
      const allowedAgents = c.get('allowedAgents') as string[];

      if (!allowedAgents.includes('*') && !allowedAgents.includes(agentName)) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      return c.json({ jsonrpc: '2.0', id: null, result: null });
    });

    return app;
  }

  /** Resolve "env:VAR" secrets to actual values. */
  private resolveSecret(secret: string): string {
    if (secret.startsWith('env:')) {
      return process.env[secret.slice(4)] ?? '';
    }

    return secret;
  }

  /** Validate bearer token; return allowedAgents or null if invalid. */
  resolveApiKey(token: string): string[] | null {
    for (const entry of Object.values(this.config.apiKeys ?? {})) {
      if (this.resolveSecret(entry.secret) === token) {
        return entry.allowedAgents;
      }
    }

    return null;
  }

  /** Build an AgentCard for the named bot. */
  buildAgentCard(agentName: string, baseUrl: string): AgentCard {
    const bot = this.config.bots[agentName];
    if (!bot) {
      throw new Error(`Unknown A2A agent: ${agentName}`);
    }

    return {
      name: agentName,
      description: `${agentName} agent (A2A)`,
      url: `${baseUrl}/agents/${agentName}`,
      version: '1.0.0',
      capabilities: {
        streaming: true,
        pushNotifications: !!(this.config.pushNotifications?.enabled),
        stateTransitionHistory: false,
      },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    };
  }

  async start(): Promise<void> {
    const port = this.config.port ?? 3100;
    this.server = serve({ fetch: this.app.fetch, port });
    log.info(`A2A server listening on port ${port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => (this.server as any).close(resolve));
      this.server = null;
    }
  }

  /** Expose the Hono app for testing via app.request(). */
  getApp(): Hono {
    return this.app;
  }
}
