import { describe, it, expect } from 'vitest';
import { TaskStore } from './task-store.js';

describe('TaskStore', () => {
  it('createTask returns a task with TASK_STATE_SUBMITTED and a uuid id', () => {
    const store = new TaskStore();
    const task = store.createTask();
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(task.contextId).toBeTruthy();
  });

  it('createTask uses provided contextId', () => {
    const store = new TaskStore();
    const task = store.createTask({ contextId: 'ctx-abc' });
    expect(task.contextId).toBe('ctx-abc');
  });

  it('getTask returns undefined for unknown id', () => {
    const store = new TaskStore();
    expect(store.getTask('nope')).toBeUndefined();
  });

  it('updateTask changes status', () => {
    const store = new TaskStore();
    const task = store.createTask();
    const updated = store.updateTask(task.id, {
      status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    });
    expect(updated.status.state).toBe('TASK_STATE_WORKING');
  });

  it('updateTask throws for unknown id', () => {
    const store = new TaskStore();
    expect(() => store.updateTask('bad-id', { status: { state: 'TASK_STATE_COMPLETED' } }))
      .toThrow('task not found: bad-id');
  });

  it('listTasks filters by state', () => {
    const store = new TaskStore();
    const t1 = store.createTask();
    store.updateTask(t1.id, { status: { state: 'TASK_STATE_WORKING' } });
    const t2 = store.createTask(); // stays SUBMITTED
    const result = store.listTasks({ state: 'TASK_STATE_WORKING' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe(t1.id);
  });


  it('subscribeToTask fires listener when task is updated', () => {
    const store = new TaskStore();
    const task = store.createTask();
    const received: unknown[] = [];
    const unsubscribe = store.subscribeToTask(task.id, (updated) => {
      received.push(updated);
    });

    const updated = store.updateTask(task.id, {
      status: { state: 'TASK_STATE_WORKING' },
    });

    expect(received).toEqual([updated]);
    unsubscribe();
  });

  it('addPushConfig stores and getPushConfigs retrieves', () => {
    const store = new TaskStore();
    const task = store.createTask();
    const cfg = store.addPushConfig(task.id, { url: 'https://example.com/hook', token: 'tok' });
    expect(cfg.id).toBeTruthy();
    expect(store.getPushConfigs(task.id)).toHaveLength(1);
    expect(store.getPushConfig(task.id, cfg.id)?.url).toBe('https://example.com/hook');
  });
});
