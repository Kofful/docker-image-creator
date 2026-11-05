import type { CreateComposeConfigRequest, CatalogImage } from "./index";

export const ENVIRONMENT_LIMITS = {
  values: 64,
  bindings: 128,
  perService: 32,
  valueBytes: 4096,
  totalBytes: 16384,
} as const;

export function requiredEnvironmentNames(image: CatalogImage): string[] {
  if (image === "mysql") return ["MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD"];
  if (image === "mongodb") return ["MONGO_INITDB_ROOT_PASSWORD"];
  return [];
}

/** Shared completeness rules. Messages never contain supplied values. */
export function environmentInputError(
  input: CreateComposeConfigRequest,
): string | null {
  const values = new Map<string, string>();
  let totalBytes = 0;
  if (
    input.environmentValues.length > ENVIRONMENT_LIMITS.values ||
    input.environmentBindings.length > ENVIRONMENT_LIMITS.bindings
  )
    return "Too many environment values or bindings.";
  for (const entry of input.environmentValues) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.key) || values.has(entry.key))
      return "Value keys must be unique lowercase identifiers.";
    const bytes = new TextEncoder().encode(entry.value).length;
    // Process environments cannot represent NUL. Reject lone surrogates instead
    // of silently replacing them during UTF-8 encoding.
    if (
      !bytes ||
      bytes > ENVIRONMENT_LIMITS.valueBytes ||
      /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        entry.value,
      )
    )
      return "Each value must contain 1–4096 UTF-8 bytes without NUL or invalid Unicode.";
    if (!entry.purpose.trim() || entry.purpose.length > 500)
      return "Every value needs a purpose of at most 500 characters.";
    totalBytes += bytes;
    values.set(entry.key, entry.value);
  }
  if (totalBytes > ENVIRONMENT_LIMITS.totalBytes)
    return "Environment values exceed the total 16384-byte limit.";
  const services = new Set(input.services.map((service) => service.name));
  const used = new Set<string>();
  const assignments = new Set<string>();
  const counts = new Map<string, number>();
  for (const binding of input.environmentBindings) {
    const assignment = `${binding.service}:${binding.name}`;
    if (!services.has(binding.service) || !values.has(binding.valueKey))
      return "Every binding must reference a selected service and a supplied value.";
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name) ||
      assignments.has(assignment)
    )
      return "Environment names must be valid and unique within each service.";
    const count = (counts.get(binding.service) ?? 0) + 1;
    if (count > ENVIRONMENT_LIMITS.perService)
      return "A service may have at most 32 environment bindings.";
    counts.set(binding.service, count);
    assignments.add(assignment);
    used.add(binding.valueKey);
  }
  if (used.size !== values.size)
    return "Assign every supplied value to at least one service.";
  for (const service of input.services)
    for (const name of requiredEnvironmentNames(service.image))
      if (!assignments.has(`${service.name}:${name}`))
        return "Supply and bind all required database passwords before generation.";
  return null;
}
