import { describe, expect, it } from 'vitest';
import { PushNotificationStore } from './push-notification-store.js';

const config = {
  taskId: 'task-1',
  contextId: 'ctx-1',
  url: 'https://kanban.example/internal/push-callback',
  token: 'push-token',
};

describe('PushNotificationStore', () => {
  it('set stores a config with createdAt and get retrieves it by taskId', () => {
    const store = new PushNotificationStore();

    const stored = store.set(config);

    expect(stored).toMatchObject(config);
    expect(stored.createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(stored.createdAt))).toBe(false);
    expect(store.get('task-1')).toEqual(stored);
  });

  it('set overwrites an existing task config', () => {
    const store = new PushNotificationStore();
    store.set(config);

    const replacement = store.set({ ...config, url: 'http://localhost:3000/webhook', token: 'next-token' });

    expect(store.all()).toHaveLength(1);
    expect(store.get('task-1')).toEqual(replacement);
    expect(store.get('task-1')).toMatchObject({ url: 'http://localhost:3000/webhook', token: 'next-token' });
  });

  it('get returns undefined for an unknown taskId', () => {
    const store = new PushNotificationStore();

    expect(store.get('missing')).toBeUndefined();
  });

  it('delete removes an existing config and returns true', () => {
    const store = new PushNotificationStore();
    store.set(config);

    expect(store.delete('task-1')).toBe(true);
    expect(store.get('task-1')).toBeUndefined();
  });

  it('delete returns false for an unknown config', () => {
    const store = new PushNotificationStore();

    expect(store.delete('missing')).toBe(false);
  });

  it('all returns all stored configs', () => {
    const store = new PushNotificationStore();
    const first = store.set(config);
    const second = store.set({ ...config, taskId: 'task-2', contextId: 'ctx-2' });

    expect(store.all()).toEqual([first, second]);
  });
});
