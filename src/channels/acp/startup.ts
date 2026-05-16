import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpPlatformConfig } from '../../types.js';
import { createAcpServer, type AcpServer } from './server.js';

export { type AcpServer };

export async function startAcpServer(acpConfig: AcpPlatformConfig, bridge: CopilotBridge): Promise<AcpServer> {
  const bind = acpConfig.bind ?? '127.0.0.1';
  const port = acpConfig.port ?? 3030;
  return createAcpServer({ bind, port, bots: acpConfig.bots }, bridge);
}
