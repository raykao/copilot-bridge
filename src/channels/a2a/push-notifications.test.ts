import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushNotificationDispatcher } from './push-notifications.js';
import type { PushNotificationConfig, StreamResponse } from '../../types.js';

const config: PushNotificationConfig = {
  id: 'config-1',
  taskId: 'task-1',
  url: 'https://example.com/webhook',
  token: 'secret-token',
};

const payload: StreamResponse = {
  statusUpdate: {
    taskId: 'task-1',
    status: {
      state: 'TASK_STATE_WORKING',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    final: false,
  },
};

describe('PushNotificationDispatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('dispatch POSTs payload to webhook URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const dispatcher = new PushNotificationDispatcher();
    await dispatcher.dispatch(config, payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2A-Notification-Token': 'secret-token',
      },
      body: JSON.stringify(payload),
    });
  });

  it('dispatch retries on non-2xx response', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const dispatcher = new PushNotificationDispatcher();
    const dispatchPromise = dispatcher.dispatch(config, payload);
    await vi.runAllTimersAsync();
    await dispatchPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dispatch gives up after MAX_RETRIES', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const dispatcher = new PushNotificationDispatcher();
    const dispatchPromise = dispatcher.dispatch(config, payload);
    await vi.runAllTimersAsync();
    await dispatchPromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('dispatchToTask is best-effort and does not throw', async () => {
    const dispatcher = new PushNotificationDispatcher();
    vi.spyOn(dispatcher, 'dispatch').mockRejectedValueOnce(new Error('webhook failed'));

    await expect(dispatcher.dispatchToTask([config], payload)).resolves.toBeUndefined();
  });
});
