import { randomUUID } from "node:crypto";
import type {
  ComposeGenerationRequirements,
  CreateComposeConfigRequest,
} from "@docker-image-creator/contracts";
import { composeIdentity } from "./compose.revision";
import { SecretBox } from "./secret-box";

/** A deliberate allowlist at the private-input / provider-metadata boundary. */
export function prepareComposeInput(
  userId: string,
  configId: string,
  generationId: string,
  input: CreateComposeConfigRequest,
  box: SecretBox,
) {
  const values = input.environmentValues.map((entry) => {
    const id = randomUUID();
    const reference = `DIC_SECRET_${id.replaceAll("-", "")}`;
    return {
      id,
      configId,
      reference,
      purpose: entry.purpose,
      valueEncrypted: box.seal(entry.value, `${configId}:${reference}`),
      bindings: input.environmentBindings
        .filter((binding) => binding.valueKey === entry.key)
        .map((binding) => ({
          id: randomUUID(),
          configId,
          valueId: id,
          service: binding.service,
          name: binding.name,
        })),
    };
  });
  const requirements: ComposeGenerationRequirements = {
    inputVersion: 2,
    identity: composeIdentity(userId, configId, generationId),
    services: input.services.map((service) => ({ ...service })),
    instructions: input.instructions,
    environment: values.map((value) => ({
      reference: value.reference,
      purpose: value.purpose,
      bindings: value.bindings.map(({ service, name }) => ({ service, name })),
    })),
  };
  return { values, requirements };
}
