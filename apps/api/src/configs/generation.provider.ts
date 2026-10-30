import { Injectable } from "@nestjs/common";
import { setTimeout } from "node:timers/promises";
import type { ConfigServiceInput } from "@docker-image-creator/contracts";
import { GenerationSettings } from "./generation.settings";

export interface GenerationInput {
  services: ConfigServiceInput[];
  instructions?: string;
}
export abstract class GenerationProvider {
  abstract generate(
    input: GenerationInput,
    signal: AbortSignal,
  ): Promise<string>;
}

// Explicit development provider: it does not interpret prose or make LLM calls.
@Injectable()
export class FakeGenerationProvider extends GenerationProvider {
  constructor(private readonly settings: GenerationSettings) {
    super();
  }
  async generate(input: GenerationInput, signal: AbortSignal): Promise<string> {
    await setTimeout(this.settings.fakeDelayMs, undefined, { signal });
    return JSON.stringify({ schemaVersion: 1, services: input.services });
  }
}
