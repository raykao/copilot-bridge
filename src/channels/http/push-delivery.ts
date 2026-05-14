import type { SessionEvent } from '@github/copilot-sdk';
import { createLogger } from '../../logger.js';
import type { A2AStreamEvent } from './a2a-types.js';
import type { PushNotificationStore } from './push-notification-store.js';
import type { RunRegistry } from './run-registry.js';
import { isTerminalA2AEvent, mapSdkEventToA2A } from './routes/a2a-events.js';

const log = createLogger('push-delivery');

export interface PushDeliveryDeps {
  pushNotificationStore: PushNotificationStore;
  runRegistry: RunRegistry;
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: any) => void,
  ) => () => void;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

export class PushDelivery {
  private readonly deps: Required<Omit<PushDeliveryDeps, 'fetchImpl'>> & { fetchImpl: typeof fetch };
  private readonly subscriptions = new Map<string, () => void>();
  private readonly perTaskQueue = new Map<string, Promise<void>>();

  constructor(deps: PushDeliveryDeps) {
    this.deps = {
      pushNotificationStore: deps.pushNotificationStore,
      runRegistry: deps.runRegistry,
      subscribeToSessionEvents: deps.subscribeToSessionEvents,
      fetchImpl: deps.fetchImpl ?? globalThis.fetch.bind(globalThis),
      maxAttempts: deps.maxAttempts ?? 4,
      retryBaseDelayMs: deps.retryBaseDelayMs ?? 500,
    };
  }

  wireTask(taskId: string): void {
    if (this.subscriptions.has(taskId)) return;
    const entry = this.deps.runRegistry.get(taskId);
    if (!entry) {
      log.warn('wireTask called for unknown task', { taskId });
      return;
    }
    if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled') {
      log.debug('wireTask called for terminal task; ignoring', { taskId, status: entry.status });
      return;
    }

    const ctx = {
      taskId,
      contextId: entry.channelId,
      initialTask: null,
      replayTerminal: false,
      terminalReplaySession: undefined,
    } as const;

    const unsubscribe = this.deps.subscribeToSessionEvents(entry.channelId, (_sessionId, channelId, event) => {
      if (channelId !== entry.channelId) return;

      const terminal = event?.type === 'session.idle' || event?.type === 'session.error';
      if (terminal && this.deps.runRegistry.shouldSuppressCancellationTerminal(taskId, entry.channelId, event)) {
        return;
      }
      if (!terminal && !this.deps.runRegistry.isActiveRun(taskId)) {
        return;
      }

      const a2aEvent = mapSdkEventToA2A(event as SessionEvent, ctx);
      if (a2aEvent) {
        this.enqueueDeliver(taskId, a2aEvent);
        if (isTerminalA2AEvent(a2aEvent)) {
          queueMicrotask(() => this.unwireTask(taskId));
        }
      } else if (terminal) {
        queueMicrotask(() => this.unwireTask(taskId));
      }
    });

    this.subscriptions.set(taskId, unsubscribe);
  }

  unwireTask(taskId: string): void {
    const unsubscribe = this.subscriptions.get(taskId);
    if (!unsubscribe) return;
    this.subscriptions.delete(taskId);
    try { unsubscribe(); } catch (err) { log.warn('unsubscribe threw', { taskId, err }); }
  }

  activeTaskIds(): string[] { return Array.from(this.subscriptions.keys()); }

  private enqueueDeliver(taskId: string, event: A2AStreamEvent): void {
    const prev = this.perTaskQueue.get(taskId) ?? Promise.resolve();
    const next = prev.then(() => this.deliver(taskId, event)).catch((err) => {
      log.warn('delivery chain error', { taskId, err });
    });
    this.perTaskQueue.set(taskId, next);
    next.finally(() => {
      if (this.perTaskQueue.get(taskId) === next) {
        this.perTaskQueue.delete(taskId);
      }
    });
  }

  private async deliver(taskId: string, event: A2AStreamEvent): Promise<void> {
    const config = this.deps.pushNotificationStore.get(taskId);
    if (!config) return;

    const body = JSON.stringify(event);
    for (let attempt = 1; attempt <= this.deps.maxAttempts; attempt++) {
      try {
        const res = await this.deps.fetchImpl(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.token}`,
          },
          body,
        });
        if (res.ok) return;
        log.debug('push delivery non-2xx', { taskId, attempt, status: res.status });
        if (attempt === this.deps.maxAttempts) {
          log.warn('push delivery exhausted retries', { taskId, status: res.status, attempts: attempt });
          return;
        }
      } catch (err) {
        log.debug('push delivery threw', { taskId, attempt, err });
        if (attempt === this.deps.maxAttempts) {
          log.warn('push delivery exhausted retries (error)', { taskId, attempts: attempt });
          return;
        }
      }
      const delay = this.deps.retryBaseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
