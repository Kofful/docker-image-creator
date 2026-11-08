export {
  ENVIRONMENT_LIMITS,
  environmentInputError,
  requiredEnvironmentNames,
} from "./environment";
export type {
  ComposeEnvironmentReference,
  ComposeGenerationRequirements,
  ComposeGenerationResponse,
  ComposeIdentity,
  ComposeRevisionArtifact,
  ComposeRevisionHeader,
  ComposeRevisionMetadata,
  ComposeServiceMetadata,
  ConfigInputOptions,
  CreateComposeConfigRequest,
  ServiceEnvironmentBindingInput,
  SuppliedEnvironmentValueInput,
} from "./compose";

export interface HealthResponse {
  status: "ok";
  service: "api";
}

export interface CredentialsRequest {
  email: string;
  password: string;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResponse {
  user: AuthUser;
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

export type CatalogImage = "node" | "python" | "mysql" | "mongodb";
export interface ConfigServiceInput {
  name: string;
  type: "code" | "web-server" | "database";
  image: CatalogImage;
  language?: "javascript" | "python";
  /** Historical field only. New creation rejects published ports. */
  hostPort?: number;
  database?: string;
}
export interface CreateConfigRequest {
  name: string;
  description?: string;
  instructions?: string;
  services: ConfigServiceInput[];
}
export type GenerationStatus = "queued" | "running" | "succeeded" | "failed";
export interface GenerationResponse {
  id: string;
  configId: string;
  status: GenerationStatus;
  stage: string;
  provider: "fake" | "openrouter" | "openai";
  model?: string;
  inputVersion?: 2;
  error: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
  revisionId: string | null;
  runtimeValidation: "not_performed";
  cleanupPending: boolean;
}
export interface CreateConfigResponse {
  configId: string;
  generationId: string;
  status: GenerationStatus;
  statusUrl: string;
  pollAfterMs: number;
}
export interface ConfigResponse {
  id: string;
  name: string;
  description: string;
  services: ConfigServiceInput[];
  generation: GenerationResponse;
  deletion?: RuntimeOperationResponse | null;
  revision: {
    id: string;
    version: number;
    compose: string;
    digest: string;
    artifactPath: string;
  } | null;
}

export interface StartConfigRequest {
  revisionId: string;
}
export type RuntimeStatus = "queued" | "running" | "succeeded" | "failed";
export interface RuntimeOperationResponse {
  id: string;
  configId: string;
  revisionId: string;
  type: "start" | "stop" | "delete";
  status: RuntimeStatus;
  stage: string;
  error: { code: string; message: string } | null;
  cleanupPending: boolean;
  createdAt: string;
  completedAt: string | null;
}
export interface RuntimeAcceptedResponse {
  operationId: string;
  statusUrl: string;
  pollAfterMs: number;
}
export interface DeploymentResponse {
  configId: string;
  revisionId: string;
  state: "starting" | "running" | "stopping" | "stopped" | "failed" | "unknown";
  operationId: string;
  observedAt: string | null;
}

export type ContainerState =
  | "not_created"
  | "created"
  | "running"
  | "restarting"
  | "paused"
  | "exited"
  | "dead"
  | "removing"
  | "unknown";
export interface ServiceRuntimeResponse {
  name: string;
  image: string;
  state: ContainerState;
  health: "starting" | "healthy" | "unhealthy" | null;
  publishedPort: {
    host: "127.0.0.1";
    hostPort: number;
    containerPort: number;
  } | null;
  observedAt: string | null;
}
export interface ConfigServicesResponse {
  configId: string;
  revisionId: string | null;
  operationId: string | null;
  services: ServiceRuntimeResponse[];
}
export interface TerminalTicketResponse {
  ticket: string;
  expiresAt: string;
  socketPath: string;
}

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "disconnect" };

export type TerminalEndReason =
  | "disconnected"
  | "shell_exited"
  | "connection_lost"
  | "authorization_ended"
  | "container_unavailable"
  | "shell_unavailable"
  | "output_overflow"
  | "connection_failed";

export type TerminalServerMessage =
  | { type: "ready"; shell: string }
  | { type: "output"; data: string }
  | { type: "exit"; reason: TerminalEndReason };
