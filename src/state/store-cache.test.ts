/**
 * Direct cache tests for all 5 in-memory caches in src/state/store.ts.
 *
 * These tests validate cache semantics (set/get/delete/list, defensive copies,
 * cache reset, and warm-from-DB behaviour) directly against the store module.
 *
 * All keys use a `__test_cache_` prefix plus a test-local suffix so that test
 * data is easily identifiable and never collides with real data.
 *
 * Cleanup strategy:
 *   - channel_sessions  : clearChannelSession()
 *   - workspace_overrides: removeWorkspaceOverride()
 *   - dynamic_channels  : removeDynamicChannel()
 *   - channel_prefs / settings: no delete API exists, so unique timestamped keys
 *     are used; leftover rows are harmless and clearly prefixed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as store from '../state/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique prefix for every test run. Avoids cross-test pollution. */
const RUN_ID = Date.now();

/** Generate a key unique within a test given a label. */
function key(label: string): string {
  return `__test_cache_${RUN_ID}_${label}`;
}

/** Raw DB handle for creating cache/DB divergence in tests. */
function rawDb() {
  return store._getDbForTesting();
}

// ---------------------------------------------------------------------------
// 1. Channel Sessions Cache
// ---------------------------------------------------------------------------

describe('Channel Sessions Cache', () => {
  const ids: string[] = [];

  beforeEach(() => {
    store._resetChannelSessionsCache();
  });

  afterEach(() => {
    // Clean up test rows from the DB so they don't accumulate
    for (const id of ids) {
      store.clearChannelSession(id);
    }
    ids.length = 0;
    store._resetChannelSessionsCache();
  });

  it('set then get returns the stored session id', () => {
    const ch = key('sess-get');
    ids.push(ch);
    store.setChannelSession(ch, 'session-abc');
    expect(store.getChannelSession(ch)).toBe('session-abc');
  });

  it('get returns null for an unknown channel', () => {
    expect(store.getChannelSession(key('sess-unknown'))).toBeNull();
  });

  it('clearChannelSession removes the entry so the next get returns null', () => {
    const ch = key('sess-clear');
    store.setChannelSession(ch, 'to-be-cleared');
    store.clearChannelSession(ch);
    expect(store.getChannelSession(ch)).toBeNull();
  });

  it('overwriting a session updates the cached value', () => {
    const ch = key('sess-overwrite');
    ids.push(ch);
    store.setChannelSession(ch, 'first');
    store.setChannelSession(ch, 'second');
    expect(store.getChannelSession(ch)).toBe('second');
  });

  it('getAllChannelSessions includes all entries that were set', () => {
    const ch1 = key('sess-all-1');
    const ch2 = key('sess-all-2');
    ids.push(ch1, ch2);
    store.setChannelSession(ch1, 'sid-1');
    store.setChannelSession(ch2, 'sid-2');

    const all = store.getAllChannelSessions();
    const found1 = all.find(e => e.channelId === ch1);
    const found2 = all.find(e => e.channelId === ch2);
    expect(found1).toBeDefined();
    expect(found1!.sessionId).toBe('sid-1');
    expect(found2).toBeDefined();
    expect(found2!.sessionId).toBe('sid-2');
  });

  it('_resetChannelSessionsCache causes re-warm from DB on next access', () => {
    const ch = key('sess-rewarm');
    ids.push(ch);
    store.setChannelSession(ch, 'first');
    store._resetChannelSessionsCache();
    // Overwrite DB value while cache is null
    store.setChannelSession(ch, 'second');
    store._resetChannelSessionsCache();
    // Re-warm from DB must return 'second', not 'first'
    expect(store.getChannelSession(ch)).toBe('second');
  });

  it('reads come from cache, not DB (stale-read proof)', () => {
    const ch = key('sess-stale');
    ids.push(ch);
    store.setChannelSession(ch, 'cached-value');
    // Delete the row directly from DB, bypassing the cache
    rawDb().prepare('DELETE FROM channel_sessions WHERE channel_id = ?').run(ch);
    // Cache still holds the value
    expect(store.getChannelSession(ch)).toBe('cached-value');
  });
});

// ---------------------------------------------------------------------------
// 2. Channel Prefs Cache
// ---------------------------------------------------------------------------

describe('Channel Prefs Cache', () => {
  beforeEach(() => {
    store._resetPrefsCache();
  });

  afterEach(() => {
    store._resetPrefsCache();
  });

  it('insert path: set then get returns correct values', () => {
    const ch = key('prefs-insert');
    store.setChannelPrefs(ch, { model: 'gpt-4o', verbose: true });
    const prefs = store.getChannelPrefs(ch);
    expect(prefs).not.toBeNull();
    expect(prefs!.model).toBe('gpt-4o');
    expect(prefs!.verbose).toBe(true);
  });

  it('update path: merges fields onto an existing row', () => {
    const ch = key('prefs-update');
    store.setChannelPrefs(ch, { model: 'claude-3', verbose: false });
    store.setChannelPrefs(ch, { agent: 'coder', verbose: true });
    const prefs = store.getChannelPrefs(ch);
    expect(prefs!.model).toBe('claude-3');   // untouched original field
    expect(prefs!.agent).toBe('coder');      // newly set field
    expect(prefs!.verbose).toBe(true);       // updated field
  });

  it('get returns null for an unknown channel', () => {
    expect(store.getChannelPrefs(key('prefs-unknown'))).toBeNull();
  });

  it('defensive copy: mutating disabledSkills on the returned object does not corrupt the cache', () => {
    const ch = key('prefs-defcopy');
    store.setChannelPrefs(ch, { disabledSkills: ['a', 'b'] });

    const prefs = store.getChannelPrefs(ch)!;
    expect(prefs).not.toBeNull();
    prefs.disabledSkills!.push('MUTATED');

    const prefs2 = store.getChannelPrefs(ch)!;
    expect(prefs2.disabledSkills).toEqual(['a', 'b']); // cache untouched
  });

  it('_resetPrefsCache causes re-warm from DB on next access', () => {
    const ch = key('prefs-rewarm');
    store.setChannelPrefs(ch, { model: 'sonnet' });
    store._resetPrefsCache();
    // Overwrite via store (writes to DB + cache), then reset again
    store.setChannelPrefs(ch, { model: 'opus' });
    store._resetPrefsCache();
    // Must re-warm from DB and return 'opus'
    const prefs = store.getChannelPrefs(ch);
    expect(prefs).not.toBeNull();
    expect(prefs!.model).toBe('opus');
  });

  it('reads come from cache, not DB (stale-read proof)', () => {
    const ch = key('prefs-stale');
    store.setChannelPrefs(ch, { model: 'cached-model' });
    // Delete the row directly from DB, bypassing the cache
    rawDb().prepare('DELETE FROM channel_prefs WHERE channel_id = ?').run(ch);
    // Cache still holds the value
    const prefs = store.getChannelPrefs(ch);
    expect(prefs).not.toBeNull();
    expect(prefs!.model).toBe('cached-model');
  });
});

// ---------------------------------------------------------------------------
// 3. Workspace Overrides Cache
// ---------------------------------------------------------------------------

describe('Workspace Overrides Cache', () => {
  const bots: string[] = [];

  beforeEach(() => {
    store._resetWorkspaceOverridesCache();
  });

  afterEach(() => {
    for (const bot of bots) {
      store.removeWorkspaceOverride(bot);
    }
    bots.length = 0;
    store._resetWorkspaceOverridesCache();
  });

  it('set then get returns correct values', () => {
    const bot = key('ws-get');
    bots.push(bot);
    store.setWorkspaceOverride(bot, '/projects/foo', ['a', 'b']);
    const ov = store.getWorkspaceOverride(bot);
    expect(ov).not.toBeNull();
    expect(ov!.botName).toBe(bot);
    expect(ov!.workingDirectory).toBe('/projects/foo');
    expect(ov!.allowPaths).toEqual(['a', 'b']);
    expect(typeof ov!.createdAt).toBe('string');
  });

  it('get returns null for an unknown bot', () => {
    expect(store.getWorkspaceOverride(key('ws-unknown'))).toBeNull();
  });

  it('removeWorkspaceOverride removes the entry so the next get returns null', () => {
    const bot = key('ws-remove');
    store.setWorkspaceOverride(bot, '/tmp', []);
    store.removeWorkspaceOverride(bot);
    expect(store.getWorkspaceOverride(bot)).toBeNull();
  });

  it('listWorkspaceOverrides includes all added entries', () => {
    const bot1 = key('ws-list-1');
    const bot2 = key('ws-list-2');
    bots.push(bot1, bot2);
    store.setWorkspaceOverride(bot1, '/dir1', ['x']);
    store.setWorkspaceOverride(bot2, '/dir2', ['y']);

    const list = store.listWorkspaceOverrides();
    const found1 = list.find(o => o.botName === bot1);
    const found2 = list.find(o => o.botName === bot2);
    expect(found1).toBeDefined();
    expect(found1!.workingDirectory).toBe('/dir1');
    expect(found2).toBeDefined();
    expect(found2!.workingDirectory).toBe('/dir2');
  });

  it('defensive copy: mutating allowPaths on the returned object does not corrupt the cache', () => {
    const bot = key('ws-defcopy');
    bots.push(bot);
    store.setWorkspaceOverride(bot, '/path', ['a', 'b']);

    const ov = store.getWorkspaceOverride(bot)!;
    ov.allowPaths.push('MUTATED');

    const ov2 = store.getWorkspaceOverride(bot)!;
    expect(ov2.allowPaths).toEqual(['a', 'b']); // cache untouched
  });

  it('_resetWorkspaceOverridesCache causes re-warm from DB on next access', () => {
    const bot = key('ws-rewarm');
    bots.push(bot);
    store.setWorkspaceOverride(bot, '/first', []);
    store._resetWorkspaceOverridesCache();
    store.setWorkspaceOverride(bot, '/second', []);
    store._resetWorkspaceOverridesCache();
    // Must re-warm from DB and return '/second'
    const ov = store.getWorkspaceOverride(bot);
    expect(ov).not.toBeNull();
    expect(ov!.workingDirectory).toBe('/second');
  });

  it('reads come from cache, not DB (stale-read proof)', () => {
    const bot = key('ws-stale');
    bots.push(bot);
    store.setWorkspaceOverride(bot, '/cached', ['x']);
    // Delete the row directly from DB, bypassing the cache
    rawDb().prepare('DELETE FROM workspace_overrides WHERE bot_name = ?').run(bot);
    // Cache still holds the value
    const ov = store.getWorkspaceOverride(bot);
    expect(ov).not.toBeNull();
    expect(ov!.workingDirectory).toBe('/cached');
    expect(ov!.allowPaths).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// 4. Global Settings Cache
// ---------------------------------------------------------------------------

describe('Global Settings Cache', () => {
  beforeEach(() => {
    store._resetSettingsCache();
  });

  afterEach(() => {
    store._resetSettingsCache();
  });

  it('set then get returns the stored value', () => {
    const k = key('setting-get');
    store.setGlobalSetting(k, 'hello');
    expect(store.getGlobalSetting(k)).toBe('hello');
  });

  it('get returns null for an unknown key', () => {
    expect(store.getGlobalSetting(key('setting-unknown'))).toBeNull();
  });

  it('overwriting a setting updates the cached value', () => {
    const k = key('setting-overwrite');
    store.setGlobalSetting(k, 'v1');
    store.setGlobalSetting(k, 'v2');
    expect(store.getGlobalSetting(k)).toBe('v2');
  });

  it('_resetSettingsCache causes re-warm from DB on next access', () => {
    const k = key('setting-rewarm');
    store.setGlobalSetting(k, 'v1');
    store._resetSettingsCache();
    store.setGlobalSetting(k, 'v2');
    store._resetSettingsCache();
    // Must re-warm from DB and return 'v2'
    expect(store.getGlobalSetting(k)).toBe('v2');
  });

  it('reads come from cache, not DB (stale-read proof)', () => {
    const k = key('setting-stale');
    store.setGlobalSetting(k, 'cached-val');
    // Delete the row directly from DB, bypassing the cache
    rawDb().prepare('DELETE FROM settings WHERE key = ?').run(k);
    // Cache still holds the value
    expect(store.getGlobalSetting(k)).toBe('cached-val');
  });
});

// ---------------------------------------------------------------------------
// 5. Dynamic Channels Cache
// ---------------------------------------------------------------------------

describe('Dynamic Channels Cache', () => {
  const channelIds: string[] = [];

  beforeEach(() => {
    store._resetDynamicChannelsCache();
  });

  afterEach(() => {
    for (const id of channelIds) {
      store.removeDynamicChannel(id);
    }
    channelIds.length = 0;
    store._resetDynamicChannelsCache();
  });

  it('add then get returns correct values', () => {
    const id = key('dyn-get');
    channelIds.push(id);
    store.addDynamicChannel({
      channelId: id,
      platform: 'slack',
      name: 'test-channel',
      workingDirectory: '/workspace',
      isDM: false,
    });
    const ch = store.getDynamicChannel(id);
    expect(ch).not.toBeNull();
    expect(ch!.channelId).toBe(id);
    expect(ch!.platform).toBe('slack');
    expect(ch!.name).toBe('test-channel');
    expect(ch!.workingDirectory).toBe('/workspace');
    expect(ch!.isDM).toBe(false);
    expect(typeof ch!.createdAt).toBe('string');
    expect(typeof ch!.updatedAt).toBe('string');
  });

  it('get returns null for an unknown channel', () => {
    expect(store.getDynamicChannel(key('dyn-unknown'))).toBeNull();
  });

  it('removeDynamicChannel removes the entry so the next get returns null', () => {
    const id = key('dyn-remove');
    store.addDynamicChannel({
      channelId: id,
      platform: 'slack',
      name: 'to-remove',
      workingDirectory: '/tmp',
      isDM: false,
    });
    store.removeDynamicChannel(id);
    expect(store.getDynamicChannel(id)).toBeNull();
  });

  it('getDynamicChannels includes all added entries', () => {
    const id1 = key('dyn-list-1');
    const id2 = key('dyn-list-2');
    channelIds.push(id1, id2);
    store.addDynamicChannel({ channelId: id1, platform: 'slack', name: 'ch1', workingDirectory: '/a', isDM: false });
    store.addDynamicChannel({ channelId: id2, platform: 'teams', name: 'ch2', workingDirectory: '/b', isDM: true });

    const all = store.getDynamicChannels();
    const found1 = all.find(c => c.channelId === id1);
    const found2 = all.find(c => c.channelId === id2);
    expect(found1).toBeDefined();
    expect(found1!.platform).toBe('slack');
    expect(found2).toBeDefined();
    expect(found2!.isDM).toBe(true);
  });

  it('defensive copy: mutating a returned DynamicChannel does not corrupt the cache', () => {
    const id = key('dyn-defcopy');
    channelIds.push(id);
    store.addDynamicChannel({
      channelId: id,
      platform: 'slack',
      name: 'original-name',
      workingDirectory: '/orig',
      isDM: false,
    });

    const ch = store.getDynamicChannel(id)!;
    // Mutate the shallow copy - this should not affect the cached entry
    (ch as any).name = 'MUTATED';

    const ch2 = store.getDynamicChannel(id)!;
    expect(ch2.name).toBe('original-name'); // cache untouched
  });

  it('_resetDynamicChannelsCache causes re-warm from DB on next access', () => {
    const id = key('dyn-rewarm');
    channelIds.push(id);
    store.addDynamicChannel({
      channelId: id,
      platform: 'discord',
      name: 'rewarm-ch',
      workingDirectory: '/rw',
      isDM: false,
    });
    store._resetDynamicChannelsCache();
    store.addDynamicChannel({
      channelId: id,
      platform: 'teams',
      name: 'updated-ch',
      workingDirectory: '/rw2',
      isDM: true,
    });
    store._resetDynamicChannelsCache();
    // Must re-warm from DB and return the updated values
    const ch = store.getDynamicChannel(id);
    expect(ch).not.toBeNull();
    expect(ch!.platform).toBe('teams');
  });

  it('reads come from cache, not DB (stale-read proof)', () => {
    const id = key('dyn-stale');
    channelIds.push(id);
    store.addDynamicChannel({
      channelId: id,
      platform: 'slack',
      name: 'cached-ch',
      workingDirectory: '/cached',
      isDM: false,
    });
    // Delete the row directly from DB, bypassing the cache
    rawDb().prepare('DELETE FROM dynamic_channels WHERE channel_id = ?').run(id);
    // Cache still holds the value
    const ch = store.getDynamicChannel(id);
    expect(ch).not.toBeNull();
    expect(ch!.name).toBe('cached-ch');
  });

  it('addDynamicChannel upsert updates an existing cache entry', () => {
    const id = key('dyn-upsert');
    channelIds.push(id);
    store.addDynamicChannel({ channelId: id, platform: 'slack', name: 'original', workingDirectory: '/a', isDM: false });
    store.addDynamicChannel({ channelId: id, platform: 'teams', name: 'updated', workingDirectory: '/b', isDM: true });

    const ch = store.getDynamicChannel(id)!;
    expect(ch.platform).toBe('teams');
    expect(ch.name).toBe('updated');
    expect(ch.workingDirectory).toBe('/b');
    expect(ch.isDM).toBe(true);
    // Only one entry in the list
    expect(store.getDynamicChannels().filter(c => c.channelId === id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-cutting: warmAllCaches, closeDb, per-cache reset
// ---------------------------------------------------------------------------

describe('Cross-cutting cache behaviour', () => {
  it('warmAllCaches does not throw on an existing (possibly empty) DB', () => {
    expect(() => store.warmAllCaches()).not.toThrow();
  });

  it('closeDb clears all caches: data written before closeDb is re-loaded from DB on next access', () => {
    // Write one entry per cache
    const sessionCh = key('close-sess');
    const prefsCh   = key('close-prefs');
    const wsBotName = key('close-ws');
    const settingK  = key('close-setting');
    const dynId     = key('close-dyn');

    store.setChannelSession(sessionCh, 'close-test-sid');
    store.setChannelPrefs(prefsCh, { model: 'close-model' });
    store.setWorkspaceOverride(wsBotName, '/close', []);
    store.setGlobalSetting(settingK, 'close-val');
    store.addDynamicChannel({ channelId: dynId, platform: 'slack', name: 'close-ch', workingDirectory: '/close', isDM: false });

    // Close DB - wipes _db and all five caches
    store.closeDb();

    // Each accessor must now re-open DB and re-warm its cache transparently
    expect(store.getChannelSession(sessionCh)).toBe('close-test-sid');
    expect(store.getChannelPrefs(prefsCh)?.model).toBe('close-model');
    expect(store.getWorkspaceOverride(wsBotName)?.workingDirectory).toBe('/close');
    expect(store.getGlobalSetting(settingK)).toBe('close-val');
    expect(store.getDynamicChannel(dynId)?.platform).toBe('slack');

    // Cleanup
    store.clearChannelSession(sessionCh);
    store.removeWorkspaceOverride(wsBotName);
    store.removeDynamicChannel(dynId);
  });

  it('each _reset*Cache function wipes its own cache; the next read re-warms from DB', () => {
    const sessionCh = key('reset-sess');
    const prefsCh   = key('reset-prefs');
    const wsBotName = key('reset-ws');
    const settingK  = key('reset-setting');
    const dynId     = key('reset-dyn');

    store.setChannelSession(sessionCh, 'rsid');
    store.setChannelPrefs(prefsCh, { model: 'rmodel' });
    store.setWorkspaceOverride(wsBotName, '/reset', []);
    store.setGlobalSetting(settingK, 'rval');
    store.addDynamicChannel({ channelId: dynId, platform: 'teams', name: 'rchan', workingDirectory: '/reset', isDM: false });

    // Reset all caches one by one
    store._resetChannelSessionsCache();
    store._resetPrefsCache();
    store._resetWorkspaceOverridesCache();
    store._resetSettingsCache();
    store._resetDynamicChannelsCache();

    // Each accessor should transparently re-warm and return the persisted data
    expect(store.getChannelSession(sessionCh)).toBe('rsid');
    expect(store.getChannelPrefs(prefsCh)?.model).toBe('rmodel');
    expect(store.getWorkspaceOverride(wsBotName)?.workingDirectory).toBe('/reset');
    expect(store.getGlobalSetting(settingK)).toBe('rval');
    expect(store.getDynamicChannel(dynId)?.platform).toBe('teams');

    // Cleanup
    store.clearChannelSession(sessionCh);
    store.removeWorkspaceOverride(wsBotName);
    store.removeDynamicChannel(dynId);
  });
});
