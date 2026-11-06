/** Provider adapters return untrusted content; routine tests replace this boundary. */
export abstract class GenerationProvider<Input, Output> {
  abstract generate(input: Input, signal: AbortSignal): Promise<Output>;
}
