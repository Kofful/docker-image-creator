import { Injectable } from "@nestjs/common";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import {
  COMPOSE_GENERATION_MS,
  ComposeGenerationProvider,
  ComposeValidationFailure,
  type ComposeProviderResult,
  type ComposeValidationCode,
  withinComposeDeadline,
} from "./compose.provider";

/** Product-only one-repair orchestration. Evaluation calls the provider directly. */
@Injectable()
export class ComposeGenerator {
  constructor(private readonly provider: ComposeGenerationProvider) {}

  async generateValidated<T>(
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
    validate: (compose: string) => T,
  ): Promise<{ value: T; responses: ComposeProviderResult[] }> {
    return withinComposeDeadline(
      signal,
      COMPOSE_GENERATION_MS,
      async (bounded) => {
        const responses: ComposeProviderResult[] = [];
        let repair: ComposeValidationCode | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await this.provider.generate(input, bounded, repair);
          if (bounded.aborted) throw bounded.reason;
          responses.push(response);
          try {
            return { value: validate(response.compose), responses };
          } catch (error) {
            if (!(error instanceof ComposeValidationFailure) || attempt === 1)
              throw error;
            repair = error.code;
          }
        }
        throw new Error("Unreachable generation state");
      },
    );
  }
}
