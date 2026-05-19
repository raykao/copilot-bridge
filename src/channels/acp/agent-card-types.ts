export interface AgentCardSupportedInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
}

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentCardCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: AgentCardSupportedInterface[];
  capabilities: AgentCardCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
}
