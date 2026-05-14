export interface StoredPushConfig {
  taskId: string;
  contextId: string;
  url: string;
  token: string;
  createdAt: string;
}

export class PushNotificationStore {
  private configs = new Map<string, StoredPushConfig>();

  set(config: Omit<StoredPushConfig, 'createdAt'>): StoredPushConfig {
    const stored: StoredPushConfig = {
      ...config,
      createdAt: new Date().toISOString(),
    };
    this.configs.set(config.taskId, stored);
    return stored;
  }

  get(taskId: string): StoredPushConfig | undefined {
    return this.configs.get(taskId);
  }

  delete(taskId: string): boolean {
    return this.configs.delete(taskId);
  }

  all(): StoredPushConfig[] {
    return Array.from(this.configs.values());
  }
}
