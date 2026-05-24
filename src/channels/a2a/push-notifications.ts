import { createLogger } from '../../logger.js';
import type { PushNotificationConfig, StreamResponse } from '../../types.js';

const log = createLogger('a2a:push');

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const VERIFY_TIMEOUT_MS = 5000;

// Uses Node 22 native fetch -- no additional HTTP client needed.

export class PushNotificationDispatcher {
  private enabled: boolean;
  private verifyWebhook: boolean;

  constructor(opts?: { enabled?: boolean; verifyWebhook?: boolean }) {
    this.enabled = opts?.enabled ?? true;
    this.verifyWebhook = opts?.verifyWebhook ?? false;
  }

  /** Verify webhook reachability by sending a GET request. Returns true if reachable. */
  async verifyWebhookUrl(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      // Any 2xx or 4xx means the server is reachable
      return res.status >= 200 && res.status < 500;
    } catch {
      return false;
    }
  }

  /** POST a StreamResponse payload to the webhook. Retries up to MAX_RETRIES times. */
  async dispatch(config: PushNotificationConfig, payload: StreamResponse): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.token) {
          headers['X-A2A-Notification-Token'] = config.token;
        }
        const res = await fetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        if (res.ok) return;
        // non-2xx
        if (attempt >= MAX_RETRIES) {
          log.warn(`dispatch: gave up after ${MAX_RETRIES} retries for ${config.url} (last status ${res.status})`);
          return;
        }
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        log.warn(`dispatch: attempt ${attempt + 1} failed (status ${res.status}), retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        attempt++;
      } catch (err) {
        if (attempt >= MAX_RETRIES) {
          log.warn(`dispatch: gave up after ${MAX_RETRIES} retries for ${config.url}`, err);
          return;
        }
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        log.warn(`dispatch: attempt ${attempt + 1} threw, retrying in ${backoff}ms`, err);
        await new Promise((r) => setTimeout(r, backoff));
        attempt++;
      }
    }
  }

  /** Dispatch to all registered configs for a task. Best-effort -- does not throw. */
  async dispatchToTask(configs: PushNotificationConfig[], payload: StreamResponse): Promise<void> {
    await Promise.all(
      configs.map((config) =>
        this.dispatch(config, payload).catch((err) => {
          log.warn(`dispatchToTask: error dispatching to ${config.url}`, err);
        })
      )
    );
  }
}
