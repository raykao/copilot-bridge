import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { RunEntry, RunRegistry } from '../run-registry.js';
import type { PushNotificationStore } from '../push-notification-store.js';
import type {
  A2APushNotificationConfigDeleteParams,
  A2APushNotificationConfigSetParams,
} from '../a2a-types.js';

export interface A2APushNotificationRouteDeps {
  bots: Record<string, unknown>;
  runRegistry: RunRegistry;
  pushNotificationStore: PushNotificationStore;
  /** Called after a config is stored. C1 receives a no-op stub; C2 replaces with PushDelivery.wireTask. */
  onConfigSet: (taskId: string) => void;
  /** Called after a config is deleted (or auto-cleared on terminal). C1 stub; C2 replaces with PushDelivery.unwireTask. */
  onConfigDeleted: (taskId: string) => void;
}

export function registerA2APushNotificationRoutes(
  app: FastifyInstance,
  deps: A2APushNotificationRouteDeps,
): void {
  app.post<{ Params: { name: string }; Body: Partial<A2APushNotificationConfigSetParams> }>(
    '/agents/:name/tasks::pushNotificationConfig::set',
    async (request, reply) => {
      const agentName = checkAuth(request, reply, deps);
      if (!agentName) return;

      const checkedBody = validateSetBody(request.body, reply);
      if (!checkedBody.ok) return;
      const { taskId, pushNotificationConfig } = checkedBody.body;

      const checkedTask = lookupTask(taskId, agentName, reply, deps);
      if (!checkedTask.ok) return;
      if (isTerminalRunStatus(checkedTask.entry.status)) {
        return reply.status(409).send({ error: 'Task is in terminal state' });
      }

      deps.pushNotificationStore.set({
        taskId,
        contextId: checkedTask.entry.channelId,
        url: pushNotificationConfig.url,
        token: pushNotificationConfig.token,
      });
      deps.onConfigSet(taskId);

      return reply.status(200).send({
        taskId,
        pushNotificationConfig: {
          url: pushNotificationConfig.url,
          token: pushNotificationConfig.token,
        },
      });
    },
  );

  app.post<{ Params: { name: string }; Body: Partial<A2APushNotificationConfigDeleteParams> }>(
    '/agents/:name/tasks::pushNotificationConfig::delete',
    async (request, reply) => {
      const agentName = checkAuth(request, reply, deps);
      if (!agentName) return;

      const id = request.body?.id;
      if (typeof id !== 'string' || id.length === 0) {
        return reply.status(400).send({ error: 'Missing required field: id' });
      }

      const checkedTask = lookupTask(id, agentName, reply, deps);
      if (!checkedTask.ok) return;

      const removed = deps.pushNotificationStore.delete(id);
      deps.onConfigDeleted(id);
      if (!removed) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      return reply.status(200).send({});
    },
  );
}

type CheckTaskOk = { ok: true; entry: RunEntry };
type CheckTaskErr = { ok: false };

type ValidSetBody = {
  taskId: string;
  pushNotificationConfig: {
    url: string;
    token: string;
  };
};

type SetBodyOk = { ok: true; body: ValidSetBody };
type SetBodyErr = { ok: false };

function checkAuth(
  request: FastifyRequest<{ Params: { name: string } }>,
  reply: FastifyReply,
  deps: A2APushNotificationRouteDeps,
): string | undefined {
  if (!request.apiKey) {
    reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    return undefined;
  }
  if (!canPerformOp(request.apiKey, 'agent:execute')) {
    reply.status(403).send({ error: 'Forbidden' });
    return undefined;
  }
  const agentName = request.params.name;
  if (!deps.bots[agentName]) {
    reply.status(404).send({ error: 'Agent not found' });
    return undefined;
  }
  if (!canAccessAgent(request.apiKey, agentName)) {
    reply.status(403).send({ error: 'Not authorized for this agent' });
    return undefined;
  }
  return agentName;
}

function validateSetBody(
  body: Partial<A2APushNotificationConfigSetParams> | undefined,
  reply: FastifyReply,
): SetBodyOk | SetBodyErr {
  if (typeof body?.taskId !== 'string' || body.taskId.length === 0) {
    reply.status(400).send({ error: 'Missing required field: taskId' });
    return { ok: false };
  }
  if (!isRecord(body.pushNotificationConfig)) {
    reply.status(400).send({ error: 'Missing required field: pushNotificationConfig' });
    return { ok: false };
  }
  if (typeof body.pushNotificationConfig.url !== 'string' || body.pushNotificationConfig.url.length === 0) {
    reply.status(400).send({ error: 'Missing required field: pushNotificationConfig.url' });
    return { ok: false };
  }
  if (!isHttpUrl(body.pushNotificationConfig.url)) {
    reply.status(400).send({ error: 'pushNotificationConfig.url must be an http(s) URL' });
    return { ok: false };
  }
  if (typeof body.pushNotificationConfig.token !== 'string' || body.pushNotificationConfig.token.length === 0) {
    reply.status(400).send({ error: 'Missing required field: pushNotificationConfig.token' });
    return { ok: false };
  }

  return {
    ok: true,
    body: {
      taskId: body.taskId,
      pushNotificationConfig: {
        url: body.pushNotificationConfig.url,
        token: body.pushNotificationConfig.token,
      },
    },
  };
}

function lookupTask(
  taskId: string,
  agentName: string,
  reply: FastifyReply,
  deps: A2APushNotificationRouteDeps,
): CheckTaskOk | CheckTaskErr {
  const entry = deps.runRegistry.get(taskId);
  if (!entry || entry.bot !== agentName) {
    reply.status(404).send({ error: 'Task not found' });
    return { ok: false };
  }
  return { ok: true, entry };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isTerminalRunStatus(status: RunEntry['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
