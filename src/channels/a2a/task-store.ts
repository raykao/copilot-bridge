import { randomUUID } from 'node:crypto';
import type { Task, TaskStateValue, A2AMessage, Artifact, PushNotificationConfig } from '../../types.js';

export interface CreateTaskOptions {
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface ListTasksFilter {
  state?: TaskStateValue;
  contextId?: string;
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private pushConfigs = new Map<string, PushNotificationConfig[]>(); // taskId -> configs

  createTask(opts?: CreateTaskOptions): Task {
    const task: Task = {
      id: randomUUID(),
      contextId: opts?.contextId ?? randomUUID(),
      status: {
        state: 'TASK_STATE_SUBMITTED',
        timestamp: new Date().toISOString(),
      },
      ...(opts?.metadata ? { metadata: { ...opts.metadata } } : {}),
    };

    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  updateTask(id: string, update: Partial<Pick<Task, 'status' | 'artifacts' | 'history' | 'metadata'>>): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error('task not found: ' + id);
    }

    const updatedStatus = update.status
      ? {
          ...task.status,
          ...update.status,
          timestamp: update.status.timestamp ?? new Date().toISOString(),
        }
      : task.status;

    const updated: Task = {
      ...task,
      ...update,
      status: updatedStatus,
      ...(update.artifacts ? { artifacts: [...update.artifacts] as Artifact[] } : {}),
      ...(update.history ? { history: [...update.history] as A2AMessage[] } : {}),
      ...(update.metadata ? { metadata: { ...update.metadata } } : {}),
    };

    this.tasks.set(id, updated);
    return updated;
  }

  listTasks(filter?: ListTasksFilter, pageSize?: number, pageToken?: string): { tasks: Task[]; nextPageToken: string } {
    const start = pageToken ? parseInt(Buffer.from(pageToken, 'base64').toString(), 10) : 0;
    const size = pageSize ?? 50;

    let tasks = Array.from(this.tasks.values());

    if (filter?.state) {
      tasks = tasks.filter((task) => task.status.state === filter.state);
    }

    if (filter?.contextId) {
      tasks = tasks.filter((task) => task.contextId === filter.contextId);
    }

    tasks.sort((a, b) => (b.status.timestamp ?? '').localeCompare(a.status.timestamp ?? ''));

    const sliced = tasks.slice(start, start + size);
    const nextToken = start + size < tasks.length ? Buffer.from(String(start + size)).toString('base64') : undefined;

    return { tasks: sliced, nextPageToken: nextToken ?? '' };
  }

  deleteTask(id: string): void {
    this.tasks.delete(id);
    this.pushConfigs.delete(id);
  }

  addPushConfig(taskId: string, config: Omit<PushNotificationConfig, 'id' | 'taskId'>): PushNotificationConfig {
    const created: PushNotificationConfig = { id: randomUUID(), taskId, ...config };
    const configs = [...(this.pushConfigs.get(taskId) ?? []), created];
    this.pushConfigs.set(taskId, configs);
    return created;
  }

  getPushConfigs(taskId: string): PushNotificationConfig[] {
    return this.pushConfigs.get(taskId) ?? [];
  }

  getPushConfig(taskId: string, configId: string): PushNotificationConfig | undefined {
    return this.getPushConfigs(taskId).find((config) => config.id === configId);
  }
}
