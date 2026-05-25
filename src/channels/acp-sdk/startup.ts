import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpPlatformConfig } from '../../types.js';
import { createAcpSdkServer, type AcpSdkServer } from './server.js';

export { type AcpSdkServer };

export async function startAcpSdkServer(
  acpConfig: AcpPlatformConfig,
  bridge: CopilotBridge,
  bridgeVersion: string,
): Promise<AcpSdkServer> {
  const bind = acpConfig.bind ?? '127.0.0.1';
  const port = acpConfig.port ?? 3031;
  return createAcpSdkServer({ bind, port, bots: acpConfig.agents, bridgeVersion }, bridge);
}
