import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpPlatformConfig } from '../../types.js';
import { createAcpTcpServer, type AcpTcpServer } from './tcp-server.js';

export { type AcpTcpServer };

export async function startAcpServers(
  acpConfig: AcpPlatformConfig,
  bridge: CopilotBridge,
  _bridgeVersion: string,
): Promise<AcpTcpServer[]> {
  const bind = acpConfig.bind ?? '127.0.0.1';
  const basePort = acpConfig.basePort ?? 3000;

  const entries = Object.entries(acpConfig.agents);
  const servers: AcpTcpServer[] = [];

  for (let i = 0; i < entries.length; i++) {
    const [agentName, botCfg] = entries[i];
    const port = botCfg.port ?? basePort + i;
    const server = await createAcpTcpServer({ bind, port, agentName, botCfg }, bridge);
    servers.push(server);
  }

  return servers;
}
