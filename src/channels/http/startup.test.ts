import { describe, expect, it } from 'vitest';
import type { HttpPlatformConfig } from '../../types.js';
import { buildAcpWsUrl, buildHttpAuthConfig, buildHttpRouteBots } from './startup.js';

function createHttpConfig(overrides: Partial<HttpPlatformConfig> = {}): HttpPlatformConfig {
  return {
    enabled: true,
    bind: '127.0.0.1',
    port: 7878,
    apiKeys: {
      primary: {
        secret: 'env:HTTP_API_KEY_PRIMARY',
        allowedAgents: ['bob'],
        allowedOps: ['card:read'],
      },
    },
    bots: {
      bob: {
        token: 'token-1',
        agent: 'bob-agent',
        admin: true,
      },
      annie: {
        token: 'token-2',
      },
    },
    ...overrides,
  };
}

describe('http startup helpers', () => {
  it('builds auth config from resolved secrets', () => {
    const config = createHttpConfig({
      apiKeys: {
        primary: {
          secret: 'env:HTTP_API_KEY_PRIMARY',
          allowedAgents: ['bob'],
          allowedOps: ['card:read'],
        },
        secondary: {
          secret: 'env:HTTP_API_KEY_SECONDARY',
          allowedAgents: ['*'],
          allowedOps: ['run:create'],
        },
      },
    });

    const authConfig = buildHttpAuthConfig(config, (keyName) => `resolved-${keyName}`);

    expect(authConfig.keys.get('primary')).toEqual({
      secret: 'resolved-primary',
      allowedAgents: ['bob'],
      allowedOps: ['card:read'],
    });
    expect(authConfig.keys.get('secondary')).toEqual({
      secret: 'resolved-secondary',
      allowedAgents: ['*'],
      allowedOps: ['run:create'],
    });
  });

  it('throws when a resolved api key secret is missing', () => {
    const config = createHttpConfig();

    expect(() => buildHttpAuthConfig(config, () => undefined)).toThrow(
      'Platform "http" apiKey "primary" secret was not resolved at startup',
    );
  });

  it('builds ACP bot metadata from configured http bots', () => {
    const bots = buildHttpRouteBots(createHttpConfig());

    expect(bots).toStrictEqual({
      bob: {
        token: 'token-1',
        agent: 'bob-agent',
      },
      annie: {
        token: 'token-2',
        agent: undefined,
      },
    });
  });
});

describe('buildAcpWsUrl', () => {
  it('converts http to ws and replaces port', () => {
    expect(buildAcpWsUrl('http://localhost:7878', 3030)).toBe('ws://localhost:3030');
  });

  it('converts https to wss and replaces port', () => {
    expect(buildAcpWsUrl('https://bridge.example.com', 3030))
      .toBe('wss://bridge.example.com:3030');
  });

  it('handles URL without explicit port', () => {
    expect(buildAcpWsUrl('http://bridge.example.com', 3030))
      .toBe('ws://bridge.example.com:3030');
  });

  it('strips path from publicBaseUrl', () => {
    expect(buildAcpWsUrl('http://localhost:7878/some/path', 3030))
      .toBe('ws://localhost:3030');
  });

  it('returns undefined for invalid URL', () => {
    expect(buildAcpWsUrl('not-a-url', 3030)).toBeUndefined();
  });
});
