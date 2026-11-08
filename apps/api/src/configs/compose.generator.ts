import { Injectable } from "@nestjs/common";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import {
  COMPOSE_GENERATION_MS,
  ComposeGenerationProvider,
  type ComposeProviderResult,
  withinComposeDeadline,
} from "./compose.provider";

/** Generate once, capture the response, then validate without replacement requests. */
@Injectable()
export class ComposeGenerator {
  constructor(private readonly provider: ComposeGenerationProvider) {}

  async generateValidated<T>(
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
    validate: (compose: string) => T,
    capture?: (response: ComposeProviderResult) => Promise<void>,
  ): Promise<{ value: T; response: ComposeProviderResult }> {
    return withinComposeDeadline(
      signal,
      COMPOSE_GENERATION_MS,
      async (bounded) => {
        const response = await this.provider.generate(input, bounded);
        if (bounded.aborted) throw bounded.reason;
        await capture?.(response);
        if (bounded.aborted) throw bounded.reason;
        return { value: validate(response.compose), response };
      },
    );
  }
}
