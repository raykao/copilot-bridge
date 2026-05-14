import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    platforms: {
      http: {
        enabled: true,
        apiKeys: {},
        bots: {},
      },
    },
    channels: [],
    defaults: {
      model: 'claude-sonnet-4.6',
      triggerMode: 'all',
      threadedReplies: false,
      verbose: false,
    },
  } as any,
  isConfiguredChannel: vi.fn(async () => false),
  registerDynamicChannel: vi.fn(),
  initWorkspace: vi.fn(async (_bot: string, override?: string) => override ?? '/default'),
  getWorkspacePath: vi.fn(async (bot: string) => `/default/${bot}`),
  getWorkspaceOverride: vi.fn(async (_bot: string) => null as { workingDirectory: string } | null),
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
  getConfig: vi.fn(() => mocks.config),
  getHttpApiKeySecret: vi.fn(),
  isConfiguredChannel: mocks.isConfiguredChannel,
  registerDynamicChannel: mocks.registerDynamicChannel,
  markChannelAsDM: vi.fn(),
  getChannelConfig: vi.fn(),
  getPlatformBots: vi.fn(() => new Map()),
  getPlatformAccess: vi.fn(),
  getChannelBotName: vi.fn(),
  isBotAdmin: vi.fn(() => false),
  getHardcodedRules: vi.fn(() => []),
  getConfigRules: vi.fn(() => []),
  reloadConfig: vi.fn(),
  ConfigWatcher: class {
    start() {}
    stop() {}
  },
}));

vi.mock('./core/workspace-manager.js', () => ({
  WorkspaceWatcher: class {
    start() {}
    stop() {}
  },
  initWorkspace: mocks.initWorkspace,
  getWorkspacePath: mocks.getWorkspacePath,
}));

vi.mock('./state/store.js', () => ({
  initStore: vi.fn(),
  getChannelPrefs: vi.fn(),
  setChannelPrefs: vi.fn(),
  getAllChannelSessions: vi.fn(async () => []),
  closeDb: vi.fn(),
  listPermissionRulesForScope: vi.fn(async () => []),
  addPermissionRule: vi.fn(),
  removePermissionRule: vi.fn(),
  clearPermissionRules: vi.fn(),
  getTaskHistory: vi.fn(async () => []),
  checkPermission: vi.fn(async () => null),
  getWorkspaceOverride: mocks.getWorkspaceOverride,
}));

import { registerHttpChannel } from './index.js';

describe('registerHttpChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.platforms.http.bots = {};
    mocks.config.channels = [];
    mocks.isConfiguredChannel.mockResolvedValue(false);
    mocks.initWorkspace.mockImplementation(async (_bot: string, override?: string) => override ?? '/default');
    mocks.getWorkspacePath.mockImplementation(async (bot: string) => `/default/${bot}`);
    mocks.getWorkspaceOverride.mockResolvedValue(null);
  });

  it('uses workingDirectory from the HTTP bot config when present', async () => {
    mocks.config.platforms.http.bots = {
      bob: { token: 'token', workingDirectory: '/custom/ws' },
    };

    await registerHttpChannel('run-custom-123456789', 'bob');

    expect(mocks.getWorkspacePath).not.toHaveBeenCalled();
    expect(mocks.initWorkspace).toHaveBeenCalledWith('bob', '/custom/ws');
    expect(mocks.registerDynamicChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-custom-123456789',
      platform: 'http',
      bot: 'bob',
      workingDirectory: '/custom/ws',
    }));
  });

  it('prefers a SQLite workspace override over HTTP bot workingDirectory', async () => {
    mocks.config.platforms.http.bots = {
      bob: { token: 'token', workingDirectory: '/custom/ws' },
    };
    mocks.getWorkspaceOverride.mockResolvedValue({ workingDirectory: '/sqlite/ws' });

    await registerHttpChannel('run-override-123456789', 'bob');

    expect(mocks.getWorkspacePath).not.toHaveBeenCalled();
    expect(mocks.initWorkspace).toHaveBeenCalledWith('bob', '/sqlite/ws');
    expect(mocks.registerDynamicChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-override-123456789',
      platform: 'http',
      bot: 'bob',
      workingDirectory: '/sqlite/ws',
    }));
  });

  it('falls back to getWorkspacePath when the HTTP bot config has no workingDirectory', async () => {
    mocks.config.platforms.http.bots = {
      bob: { token: 'token' },
    };

    await registerHttpChannel('run-default-123456789', 'bob');

    expect(mocks.getWorkspacePath).toHaveBeenCalledWith('bob');
    expect(mocks.initWorkspace).toHaveBeenCalledWith('bob', '/default/bob');
    expect(mocks.registerDynamicChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-default-123456789',
      platform: 'http',
      bot: 'bob',
      workingDirectory: '/default/bob',
    }));
  });

  it('falls back to getWorkspacePath when the bot is absent from HTTP config', async () => {
    mocks.config.platforms.http.bots = {
      alice: { token: 'token', workingDirectory: '/alice/ws' },
    };

    await registerHttpChannel('run-absent-123456789', 'bob');

    expect(mocks.getWorkspacePath).toHaveBeenCalledWith('bob');
    expect(mocks.initWorkspace).toHaveBeenCalledWith('bob', '/default/bob');
    expect(mocks.registerDynamicChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-absent-123456789',
      platform: 'http',
      bot: 'bob',
      workingDirectory: '/default/bob',
    }));
  });
});
