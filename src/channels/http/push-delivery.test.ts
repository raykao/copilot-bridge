import type { SessionEvent } from '@github/copilot-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushNotificationStore } from './push-notification-store.js';
import { RunRegistry, type RunStatus } from './run-registry.js';
import { PushDelivery } from './push-delivery.js';

// Retry tests use vi.useFakeTimers() with vi.advanceTimersByTimeAsync() so each backoff delay is explicit.
const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mockLog,
}));

type SessionEventHandler = (sessionId: string, channelId: string, event: any) => void;

interface Harness {
  delivery: PushDelivery;
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  runRegistry: RunRegistry;
  pushNotificationStore: PushNotificationStore;
  subscribeToSessionEvents: ReturnType<typeof vi.fn<(channelId: string, handler: SessionEventHandler) => () => void>>;
  unsubscribeFns: ReturnType<typeof vi.fn>[];
  emit: (event: SessionEvent, channelId?: string) => void;
  registerTask: (status?: RunStatus) => void;
}

describe('PushDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers one mapped SDK event to the registered webhook', async () => {
    const h = createHarness();
    h.registerTask();
    h.delivery.wireTask('task-1');

    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'hello' }));
    await flushPromises();

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://kanban.example/hook');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer push-token',
      },
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      taskId: 'task-1',
      contextId: 'ctx-1',
      kind: 'artifact-update',
      artifact: { parts: [{ kind: 'text', text: 'hello' }] },
    });
  });

  it('retries a non-2xx response and then succeeds', async () => {
    vi.useFakeTimers();
    const h = createHarness({ retryBaseDelayMs: 500 });
    h.fetchImpl
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(200));
    h.registerTask();
    h.delivery.wireTask('task-1');

    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'hello' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);

    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('stops after max attempts and logs retry exhaustion', async () => {
    vi.useFakeTimers();
    const h = createHarness({ maxAttempts: 4, retryBaseDelayMs: 500 });
    h.fetchImpl.mockResolvedValue(response(500));
    h.registerTask();
    h.delivery.wireTask('task-1');

    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'hello' }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.fetchImpl).toHaveBeenCalledTimes(4);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith('push delivery exhausted retries', {
      taskId: 'task-1',
      status: 500,
      attempts: 4,
    });
  });

  it('unwires when a terminal SDK event is emitted', async () => {
    const h = createHarness();
    h.registerTask();
    h.delivery.wireTask('task-1');

    h.emit(sdkEvent('session.idle'));
    await flushPromises();

    expect(h.delivery.activeTaskIds()).toEqual([]);
    expect(h.unsubscribeFns[0]).toHaveBeenCalledTimes(1);
  });

  it('unwires on explicit delete and ignores later events from that subscription', async () => {
    const h = createHarness();
    h.registerTask();
    h.delivery.wireTask('task-1');

    h.delivery.unwireTask('task-1');
    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'hello' }));
    await flushPromises();

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.unsubscribeFns[0]).toHaveBeenCalledTimes(1);
  });

  it('serializes deliveries for a task in emission order', async () => {
    const h = createHarness();
    let resolveFirst: (value: Response) => void = () => undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    h.fetchImpl
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200));
    h.registerTask();
    h.delivery.wireTask('task-1');

    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'one' }));
    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'two' }));
    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'three' }));
    await flushPromises();

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetchImpl.mock.calls[0]![1]?.body)).artifact.parts[0].text).toBe('one');

    resolveFirst(response(200));
    await flushPromises(8);

    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(h.fetchImpl.mock.calls[1]![1]?.body)).artifact.parts[0].text).toBe('two');
    expect(JSON.parse(String(h.fetchImpl.mock.calls[2]![1]?.body)).artifact.parts[0].text).toBe('three');
  });

  it('wireTask is idempotent for an already-wired task', async () => {
    const h = createHarness();
    h.registerTask();

    h.delivery.wireTask('task-1');
    h.delivery.wireTask('task-1');
    h.emit(sdkEvent('assistant.message_delta', { deltaContent: 'hello' }));
    await flushPromises();

    expect(h.subscribeToSessionEvents).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logs and skips wireTask for a missing task', () => {
    const h = createHarness();

    h.delivery.wireTask('missing');

    expect(h.subscribeToSessionEvents).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith('wireTask called for unknown task', { taskId: 'missing' });
    expect(h.delivery.activeTaskIds()).toEqual([]);
  });

  it('skips wireTask for a terminal task', () => {
    const h = createHarness();
    h.registerTask('completed');

    h.delivery.wireTask('task-1');

    expect(h.subscribeToSessionEvents).not.toHaveBeenCalled();
    expect(h.delivery.activeTaskIds()).toEqual([]);
  });
});

function createHarness(options: { maxAttempts?: number; retryBaseDelayMs?: number } = {}): Harness {
  const runRegistry = new RunRegistry();
  const pushNotificationStore = new PushNotificationStore();
  const handlers = new Map<string, SessionEventHandler>();
  const unsubscribeFns: ReturnType<typeof vi.fn>[] = [];
  const subscribeToSessionEvents = vi.fn((channelId: string, handler: SessionEventHandler) => {
    handlers.set(channelId, handler);
    const unsubscribe = vi.fn(() => {
      if (handlers.get(channelId) === handler) {
        handlers.delete(channelId);
      }
    });
    unsubscribeFns.push(unsubscribe);
    return unsubscribe;
  });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(200));
  const delivery = new PushDelivery({
    pushNotificationStore,
    runRegistry,
    subscribeToSessionEvents,
    fetchImpl,
    maxAttempts: options.maxAttempts,
    retryBaseDelayMs: options.retryBaseDelayMs,
  });

  return {
    delivery,
    fetchImpl,
    runRegistry,
    pushNotificationStore,
    subscribeToSessionEvents,
    unsubscribeFns,
    emit: (event, channelId = 'ctx-1') => {
      handlers.get(channelId)?.('session-1', channelId, event);
    },
    registerTask: (status: RunStatus = 'in_progress') => {
      runRegistry.register('task-1', { bot: 'bot-a', channelId: 'ctx-1', status: 'in_progress' });
      if (status !== 'in_progress') {
        runRegistry.updateStatus('task-1', status, { finishedAt: '2026-01-01T00:00:00.000Z' });
      }
      pushNotificationStore.set({
        taskId: 'task-1',
        contextId: 'ctx-1',
        url: 'https://kanban.example/hook',
        token: 'push-token',
      });
    },
  };
}

function sdkEvent(type: string, data: Record<string, unknown> = {}): SessionEvent {
  return {
    type,
    data,
    id: `${type}-id`,
    timestamp: '2026-01-01T00:00:00.000Z',
    parentId: null,
  } as unknown as SessionEvent;
}

function response(status: number): Response {
  return new Response('', { status });
}

async function flushPromises(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}
