import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpPlatformConfig } from '../../types.js';
import { createAcpTcpServer, type AcpTcpServer } from './tcp-server.js';
import { createDiscoveryServer, type DiscoveryServer, type AgentCard } from './discovery-server.js';

export { type AcpTcpServer, type DiscoveryServer };

export async function startAcpServers(
  acpConfig: AcpPlatformConfig,
  bridge: CopilotBridge,
  _bridgeVersion: string,
): Promise<{ tcpServers: AcpTcpServer[]; discoveryServer: DiscoveryServer | null }> {
  const bind = acpConfig.bind ?? '127.0.0.1';
  const basePort = acpConfig.basePort ?? 3000;

  const entries = Object.entries(acpConfig.agents);
  const tcpServers: AcpTcpServer[] = [];

  for (let i = 0; i < entries.length; i++) {
    const [agentName, botCfg] = entries[i];
    const port = botCfg.port ?? basePort + i;
    const server = await createAcpTcpServer({ bind, port, agentName, botCfg }, bridge);
    tcpServers.push(server);
  }

  // Build discovery cards from running servers
  const cards: AgentCard[] = tcpServers.map((srv, i) => {
    const [agentName, botCfg] = entries[i];
    return {
      name: agentName,
      description: `Copilot Bridge ACP agent: ${agentName}`,
      url: `tcp://${bind}:${srv.port}`,
      workingDirectory: botCfg.workingDirectory ?? '',
      protocol: 'acp',
      transport: 'tcp',
      port: srv.port,
    };
  });

  // Start discovery server unless discoveryPort === 0 (explicit disable)
  let discoveryServer: DiscoveryServer | null = null;
  const discoveryPort = acpConfig.discoveryPort ?? 4099;
  if (discoveryPort !== 0) {
    discoveryServer = await createDiscoveryServer({ bind, port: discoveryPort, cards });
  }

  return { tcpServers, discoveryServer };
}
