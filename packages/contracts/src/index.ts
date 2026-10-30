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
  provider: "fake";
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
  revision: {
    id: string;
    version: number;
    compose: string;
    digest: string;
    artifactPath: string;
  } | null;
}
