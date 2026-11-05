import { createHash } from "node:crypto";
import type {
  ComposeIdentity,
  ComposeRevisionHeader,
} from "@docker-image-creator/contracts";
import { COMPOSE_POLICY, COMPOSE_REVISION_HEADER } from "./compose.policy";

type RevisionFailureCode =
  | "UNSUPPORTED_REVISION"
  | "INVALID_REVISION"
  | "REVISION_SCOPE_MISMATCH"
  | "REVISION_DIGEST_MISMATCH";

export class ComposeRevisionFailure extends Error {
  constructor(readonly code: RevisionFailureCode) {
    super(code);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(",") === keys.sort().join(",");
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function composeIdentity(
  userId: string,
  configId: string,
  revisionId: string,
): ComposeIdentity {
  if (![userId, configId, revisionId].every((id) => uuid.test(id)))
    throw new ComposeRevisionFailure("INVALID_REVISION");
  return { userId, configId, revisionId, projectName: `dic-${configId}` };
}

export interface ComposeRevisionCandidate extends ComposeRevisionHeader {
  identity: ComposeIdentity;
  services: unknown;
  environment: unknown;
  compose: string;
  digest: string;
}

/**
 * Version/scope/integrity gate only. Metadata remains unknown deliberately:
 * YAML and policy validation must follow before persistence or execution.
 * Legacy data cannot be upgraded by relabeling or invoking a compiler here.
 */
export function readComposeRevisionCandidate(
  metadata: unknown,
  compose: unknown,
  digest: unknown,
  expected: ComposeIdentity,
): ComposeRevisionCandidate {
  if (
    !record(metadata) ||
    metadata.format !== COMPOSE_REVISION_HEADER.format ||
    metadata.schemaVersion !== COMPOSE_REVISION_HEADER.schemaVersion ||
    metadata.policyVersion !== COMPOSE_REVISION_HEADER.policyVersion ||
    metadata.catalogVersion !== COMPOSE_REVISION_HEADER.catalogVersion
  )
    throw new ComposeRevisionFailure("UNSUPPORTED_REVISION");
  if (
    !exactKeys(metadata, [
      ...Object.keys(COMPOSE_REVISION_HEADER),
      "identity",
      "services",
      "environment",
    ]) ||
    !record(metadata.identity) ||
    !exactKeys(metadata.identity, [
      "userId",
      "configId",
      "revisionId",
      "projectName",
    ])
  )
    throw new ComposeRevisionFailure("INVALID_REVISION");
  const storedIdentity = metadata.identity;
  const identity = composeIdentity(
    expected.userId,
    expected.configId,
    expected.revisionId,
  );
  if (
    expected.projectName !== identity.projectName ||
    Object.entries(identity).some(
      ([key, value]) => storedIdentity[key] !== value,
    )
  )
    throw new ComposeRevisionFailure("REVISION_SCOPE_MISMATCH");
  if (
    typeof compose !== "string" ||
    !compose.trim() ||
    Buffer.byteLength(compose) > COMPOSE_POLICY.maxOutputBytes
  )
    throw new ComposeRevisionFailure("INVALID_REVISION");
  if (
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    createHash("sha256").update(compose).digest("hex") !== digest
  )
    throw new ComposeRevisionFailure("REVISION_DIGEST_MISMATCH");
  return {
    ...COMPOSE_REVISION_HEADER,
    identity,
    services: metadata.services,
    environment: metadata.environment,
    compose,
    digest,
  };
}
