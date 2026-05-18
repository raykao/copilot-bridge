import type { FastifyInstance } from 'fastify';
import type { PermissionHandler, SessionEvent } from '@github/copilot-sdk';
import type { AuthConfig } from './auth.js';
import type { BotConfig, HttpPlatformConfig } from '../../types.js';
import { registerAgentCardCatalogRoute, registerAgentCardRoutes } from './routes/agent-card.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerA2AMessageSendRoute } from './routes/a2a-message-send.js';
import { registerA2AMessageStreamRoute } from './routes/a2a-message-stream.js';
import { registerA2ATasksRoutes } from './routes/a2a-tasks.js';
import { registerA2APushNotificationRoutes } from './routes/a2a-push-notification.js';
import { registerRunEventsRoutes } from './routes/runs-events.js';
import { registerRunStreamRoutes } from './routes/runs-stream.js';
import { registerRunResumeRoutes } from './routes/runs-resume.js';
import { RunRegistry } from './run-registry.js';
import { PushNotificationStore } from './push-notification-store.js';
import { PushDelivery } from './push-delivery.js';
import { PermissionStore } from './permission-store.js';
import { PendingPermissionStore } from './pending-permission-store.js';
import type { HttpChannelAdapter } from './index.js';

export type HttpRouteBotConfig = Pick<BotConfig, 'agent' | 'token'> & {
  model?: string;
};

export interface HttpAcpRouteDeps {
  adapter: HttpChannelAdapter;
  bots: Record<string, HttpRouteBotConfig>;
  publicBaseUrl: string;
  bridgeVersion: string;
  acpWsUrl?: string;
  registerChannel: (channelId: string, bot: string) => Promise<void>;
  createSessionWithPermissions: (
    channelId: string,
    bot: string,
    onPermissionRequest: PermissionHandler,
  ) => Promise<{ sessionId: string }>;
  getSession: (sessionId: string) => { getMessages(): Promise<SessionEvent[]> } | undefined;
  abortSession: (sessionId: string) => Promise<void>;
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: unknown) => void,
  ) => () => void;
  addPermissionRule: (channelId: string, toolName: string, cmd: string, action: 'allow' | 'deny') => Promise<void>;
  checkPermission: (channelId: string, toolName: string, command: string) => Promise<'allow' | 'deny' | null>;
}

export interface HttpAcpRouteStores {
  runRegistry: RunRegistry;
  permissionStore: PermissionStore;
  pendingPermissionStore: PendingPermissionStore;
  pushNotificationStore: PushNotificationStore;
  pushDelivery: PushDelivery;
}

/**
 * Converts the HTTP public base URL to an ACP WebSocket base URL by swapping
 * the protocol (http->ws, https->wss) and replacing the port with acpPort.
 * Returns undefined if publicBaseUrl is not a valid URL.
 *
 * Examples:
 *   buildAcpWsUrl('http://localhost:7878', 3030) => 'ws://localhost:3030'
 *   buildAcpWsUrl('https://bridge.example.com', 3030) => 'wss://bridge.example.com:3030'
 */
export function buildAcpWsUrl(publicBaseUrl: string, acpPort: number): string | undefined {
  try {
    const u = new URL(publicBaseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.port = String(acpPort);
    u.pathname = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function buildHttpAuthConfig(
  httpConfig: HttpPlatformConfig,
  getSecret: (keyName: string) => string | undefined,
): AuthConfig {
  const keys = new Map<string, { secret: string; allowedAgents: string[]; allowedOps: string[] }>();

  for (const [keyName, apiKey] of Object.entries(httpConfig.apiKeys)) {
    const secret = getSecret(keyName);
    if (!secret) {
      throw new Error(`Platform "http" apiKey "${keyName}" secret was not resolved at startup`);
    }

    keys.set(keyName, {
      secret,
      allowedAgents: [...apiKey.allowedAgents],
      allowedOps: [...apiKey.allowedOps],
    });
  }

  return { keys };
}

export function buildHttpRouteBots(httpConfig: HttpPlatformConfig): Record<string, HttpRouteBotConfig> {
  return Object.fromEntries(
    Object.entries(httpConfig.bots ?? {}).map(([botName, bot]) => [
      botName,
      {
        token: bot.token,
        agent: bot.agent,
      },
    ]),
  );
}

export function registerHttpAcpRoutes(app: FastifyInstance, deps: HttpAcpRouteDeps): HttpAcpRouteStores {
  const runRegistry = new RunRegistry();
  const pushNotificationStore = new PushNotificationStore();
  const pushDelivery = new PushDelivery({
    pushNotificationStore,
    runRegistry,
    subscribeToSessionEvents: deps.subscribeToSessionEvents,
  });
  const permissionStore = new PermissionStore();
  const pendingPermissionStore = new PendingPermissionStore();

  registerAgentRoutes(app, { bots: deps.bots });
  registerAgentCardRoutes(app, {
    bots: deps.bots,
    publicBaseUrl: deps.publicBaseUrl,
    bridgeVersion: deps.bridgeVersion,
    acpWsUrl: deps.acpWsUrl,
  });
  registerAgentCardCatalogRoute(app, {
    bots: deps.bots,
    publicBaseUrl: deps.publicBaseUrl,
    bridgeVersion: deps.bridgeVersion,
    acpWsUrl: deps.acpWsUrl,
  });
  registerRunRoutes(app, {
    adapter: deps.adapter,
    runRegistry,
    permissionStore,
    pendingPermissionStore,
    checkPermission: deps.checkPermission,
    createSessionWithPermissions: async (channelId, bot, onPermissionRequest) => {
      await deps.registerChannel(channelId, bot);
      return deps.createSessionWithPermissions(channelId, bot, onPermissionRequest);
    },
    subscribeToSessionEvents: deps.subscribeToSessionEvents,
    getSession: deps.getSession,
    abortSession: deps.abortSession,
  });
  registerA2AMessageSendRoute(app, {
    adapter: deps.adapter,
    bots: deps.bots,
    runRegistry,
    permissionStore,
    pendingPermissionStore,
    checkPermission: deps.checkPermission,
    createSessionWithPermissions: async (channelId, bot, onPermissionRequest) => {
      await deps.registerChannel(channelId, bot);
      return deps.createSessionWithPermissions(channelId, bot, onPermissionRequest);
    },
  });
  registerA2AMessageStreamRoute(app, {
    adapter: deps.adapter,
    bots: deps.bots,
    runRegistry,
    permissionStore,
    pendingPermissionStore,
    checkPermission: deps.checkPermission,
    createSessionWithPermissions: async (channelId, bot, onPermissionRequest) => {
      await deps.registerChannel(channelId, bot);
      return deps.createSessionWithPermissions(channelId, bot, onPermissionRequest);
    },
    subscribeToSessionEvents: deps.subscribeToSessionEvents,
    getSession: deps.getSession,
  });
  registerA2ATasksRoutes(app, {
    bots: deps.bots,
    runRegistry,
    subscribeToSessionEvents: deps.subscribeToSessionEvents,
    getSession: deps.getSession,
    abortSession: deps.abortSession,
  });
  registerA2APushNotificationRoutes(app, {
    bots: deps.bots,
    runRegistry,
    pushNotificationStore,
    onConfigSet: (taskId) => pushDelivery.wireTask(taskId),
    onConfigDeleted: (taskId) => pushDelivery.unwireTask(taskId),
  });
  registerRunEventsRoutes(app, { runRegistry, getSession: deps.getSession });
  registerRunStreamRoutes(app, {
    runRegistry,
    subscribeToSessionEvents: deps.subscribeToSessionEvents,
    getSession: deps.getSession,
  });
  registerRunResumeRoutes(app, {
    runRegistry,
    permissionStore,
    pendingPermissionStore,
    addPermissionRule: deps.addPermissionRule,
  });

  return { runRegistry, permissionStore, pendingPermissionStore, pushNotificationStore, pushDelivery };
}
