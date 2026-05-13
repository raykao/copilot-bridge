// A2A protocol type subset used by copilot-bridge.
// Spec: https://a2a-protocol.org/latest/specification/#6-objects
// Phase B includes only fields needed by message:send, message:stream,
// tasks:get, tasks:cancel, tasks:resubscribe. File and data parts are
// not yet supported (Phase B accepts text parts only).

import type { RunStatus } from './run-registry.js';

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface A2ATextPart {
  kind: 'text';
  text: string;
}

export type A2APart = A2ATextPart;

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  parts: A2APart[];
  name?: string;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  history?: A2AMessage[];
  artifacts?: A2AArtifact[];
  kind: 'task';
}

export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  final: boolean;
  kind: 'status-update';
}

export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  kind: 'artifact-update';
}

export type A2AStreamEvent =
  | A2ATask
  | A2ATaskStatusUpdateEvent
  | A2ATaskArtifactUpdateEvent;

export interface A2AMessageSendParams {
  message: A2AMessage;
}

// Map an internal RunStatus to the A2A TaskState used in responses AFTER the
// initial submitted->working transition. The initial response uses
// runStatusToInitialTaskState() which can return 'submitted'.
export function runStatusToTaskState(status: RunStatus): A2ATaskState {
  switch (status) {
    case 'created':
    case 'in_progress':
      return 'working';
    case 'awaiting':
      return 'input-required';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
  }
}

// Used ONLY for the initial response from message:send. A brand-new run with
// status === 'created' maps to 'submitted' on the first wire response.
export function runStatusToInitialTaskState(status: RunStatus): A2ATaskState {
  if (status === 'created') return 'submitted';
  return runStatusToTaskState(status);
}
