import { Injectable } from "@nestjs/common";
import { resolve } from "node:path";

@Injectable()
export class GenerationSettings {
  readonly model = process.env.OPENAI_MODEL?.trim() ?? "";
  readonly suppliedEnvironmentEnabled = true;
  readonly root = resolve(
    process.env.CONFIG_ARTIFACT_ROOT ??
      resolve(__dirname, "../../../../.runtime/configs"),
  );
  readonly llmLogRoot = resolve(
    process.env.LLM_LOG_ROOT ?? resolve(this.root, "../llm"),
  );
  readonly encryptionKey: Buffer;
  readonly generationMs = 5 * 60 * 1000;
  readonly leaseGraceMs = 30000;
  readonly queueMs = 15 * 60 * 1000;
  readonly pollMs = 1000;
  readonly maxOutputBytes = 1024 * 1024;

  constructor() {
    const key = process.env.CONFIG_ENCRYPTION_KEY;
    if (!key || !/^[a-fA-F0-9]{64}$/.test(key))
      throw new Error(
        "CONFIG_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters (32 decoded bytes). Generate it with: openssl rand -hex 32",
      );
    this.encryptionKey = Buffer.from(key, "hex");
  }
}
