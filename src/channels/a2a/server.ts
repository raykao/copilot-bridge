import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { createLogger } from '../../logger.js';
import type { A2APlatformConfig, AgentCard, JsonRpcRequest } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';
import { TaskStore } from './task-store.js';
import { SessionMap } from './session-map.js';
import { RpcErrors, RpcHandler, rpcError, type RpcContext } from './rpc-handler.js';

const log = createLogger('a2a');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value)
    && value.jsonrpc === '2.0'
    && (typeof value.id === 'string' || typeof value.id === 'number' || value.id === null)
    && typeof value.method === 'string';
}

export class A2AServer {
  private app: Hono;
  private config: A2APlatformConfig;
  private bridge: CopilotBridge;
  private rpcHandler: RpcHandler;
  private server: ReturnType<typeof serve> | null = null;

  constructor(config: A2APlatformConfig, bridge: CopilotBridge) {
    this.config = config;
    this.bridge = bridge;
    this.rpcHandler = new RpcHandler(new TaskStore(), new SessionMap(), this.bridge, this.config);
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

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(rpcError(null, RpcErrors.PARSE_ERROR), 400);
      }

      if (!isJsonRpcRequest(body)) {
        return c.json(rpcError(null, RpcErrors.INVALID_REQUEST), 400);
      }

      const acceptsSse = c.req.header('Accept')?.includes('text/event-stream') ?? false;
      if (acceptsSse) {
        const rpcReq = body;
        return streamSSE(c, async (stream) => {
          await this.rpcHandler.dispatch(rpcReq, {
            agentName,
            allowedAgents,
            isStreaming: true,
            sseStream: stream,
          } as RpcContext);
        });
      }

      const response = await this.rpcHandler.dispatch(body, {
        agentName,
        allowedAgents,
        isStreaming: false,
      });

      if (response === 'SSE') {
        return c.json(rpcError(body.id, RpcErrors.UNSUPPORTED_OPERATION), 400);
      }

      return c.json(response);
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
