import { createHash } from "node:crypto";
import type {
  ConfigServiceInput,
  ComposeGenerationRequirements,
} from "@docker-image-creator/contracts";
import { composeIdentity } from "../configs/compose.revision";
import {
  composeResourceLabels,
  COMPOSE_POLICY,
} from "../configs/compose.policy";
import {
  validateComposeRequirements,
  validateSavedCompose,
} from "../configs/compose.validator";

export const policyVersion = COMPOSE_POLICY.policyVersion;
export const labelPrefix = "docker-image-creator";
export function runtimeLabels(userId: string, configId: string) {
  return composeResourceLabels(composeIdentity(userId, configId, configId));
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// API/terminal readers select only metadata. Only the runner's Start query selects ciphertext.
export const runtimeEnvironmentSelect = {
  reference: true,
  purpose: true,
  bindings: { select: { service: true, name: true } },
} as const;
interface StoredConfig {
  id: string;
  userId: string;
  inputVersion: number;
  services: unknown;
  environmentValues: ComposeGenerationRequirements["environment"];
}
interface StoredRevision {
  id: string;
  configId: string;
  spec: unknown;
  compose: string;
  digest: string;
}
export function runtimeRequirements(
  config: StoredConfig,
  revisionId: string,
): ComposeGenerationRequirements {
  if (config.inputVersion !== 2) throw new Error("UNSUPPORTED_REVISION");
  const requirements: ComposeGenerationRequirements = {
    inputVersion: 2,
    identity: composeIdentity(config.userId, config.id, revisionId),
    services: config.services as ConfigServiceInput[],
    environment: config.environmentValues.map(
      ({ reference, purpose, bindings }) => ({
        reference,
        purpose,
        bindings: bindings.map(({ service, name }) => ({ service, name })),
      }),
    ),
  };
  validateComposeRequirements(requirements, requirements.identity);
  return requirements;
}

/** Validate original saved bytes against independently stored requirements/bindings. Never render YAML. */
export function savedRuntimeRevision(
  config: StoredConfig,
  revision: StoredRevision,
) {
  if (revision.configId !== config.id) throw new Error("INVALID_REVISION");
  const requirements = runtimeRequirements(config, revision.id);
  const artifact = validateSavedCompose(
    revision.spec,
    revision.compose,
    revision.digest,
    requirements,
  );
  return {
    requirements,
    metadata: artifact.metadata,
    services: requirements.services,
    manifest: artifact.compose,
    digest: artifact.digest,
  };
}
