// A2A AgentCard subset used by copilot-bridge.
// Spec: https://a2a-protocol.org/latest/specification/#441-agentcard
// Phase A only includes the fields we currently publish. Extending later
// (skills, signatures, etc.) is intentionally deferred.

export interface AgentCardCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
}

export interface AgentInterface {
  url: string;
  protocolBinding: string;       // "HTTP+JSON" for our REST routes
  protocolVersion: string;       // "0.3" while we are pre-1.0 internally
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export type SecuritySchemeMap = Record<string, {
  // Discriminated union from A2A spec - we only publish the http-bearer variant today.
  httpAuthSecurityScheme: {
    scheme: 'Bearer';
    description?: string;
  };
}>;

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: AgentInterface[];
  capabilities: AgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  securitySchemes?: SecuritySchemeMap;
  securityRequirements?: Array<Record<string, string[]>>;
}
