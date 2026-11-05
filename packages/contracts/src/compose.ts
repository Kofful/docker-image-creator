import type {
  CatalogImage,
  ConfigServiceInput,
  CreateConfigRequest,
  GenerationResponse,
} from "./index";

/** Creation-only private payload. Values must never appear in responses or prompts. */
export interface SuppliedEnvironmentValueInput {
  key: string;
  value: string;
  purpose: string;
}

export interface ServiceEnvironmentBindingInput {
  service: string;
  name: string;
  valueKey: string;
}

export interface CreateComposeConfigRequest extends CreateConfigRequest {
  inputVersion: 2;
  environmentValues: SuppliedEnvironmentValueInput[];
  environmentBindings: ServiceEnvironmentBindingInput[];
}

export interface ConfigInputOptions {
  suppliedEnvironment: boolean;
}

/** Server-issued reference, independent of container environment variable names. */
export interface ComposeEnvironmentReference {
  reference: string;
  purpose: string;
  bindings: { service: string; name: string }[];
}

export interface ComposeIdentity {
  userId: string;
  configId: string;
  revisionId: string;
  projectName: string;
}

/** Provider input contains metadata only; never SuppliedEnvironmentValueInput. */
export interface ComposeGenerationRequirements {
  inputVersion: 2;
  identity: ComposeIdentity;
  services: ConfigServiceInput[];
  instructions?: string;
  environment: ComposeEnvironmentReference[];
}

export interface ComposeRevisionHeader {
  format: "llm-compose";
  schemaVersion: 2;
  policyVersion: "2";
  catalogVersion: 1;
}

export interface ComposeServiceMetadata {
  name: string;
  image: CatalogImage;
  imageReference: string;
  containerPort: number;
  publishedPort: {
    host: "127.0.0.1";
    hostPort: number;
    containerPort: number;
  } | null;
  volumes: { source: string; target: string }[];
}

/** Derived from validated YAML, used for inspection, never for generating YAML. */
export interface ComposeRevisionMetadata extends ComposeRevisionHeader {
  identity: ComposeIdentity;
  services: ComposeServiceMetadata[];
  environment: ComposeEnvironmentReference[];
}

export interface ComposeRevisionArtifact {
  compose: string;
  digest: string;
  metadata: ComposeRevisionMetadata;
}

export interface ComposeGenerationResponse
  extends Omit<GenerationResponse, "provider"> {
  inputVersion: 2;
  provider: "openrouter";
  model: "google/gemma-4-26b-a4b-it:free";
}
