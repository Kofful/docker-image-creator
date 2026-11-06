import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { GenerationSettings } from "./generation.settings";

@Injectable()
export class SecretBox {
  constructor(private readonly settings: GenerationSettings) {}
  fingerprint(text: string): string {
    return createHmac("sha256", this.settings.encryptionKey)
      .update("compose-input-v2\0")
      .update(text)
      .digest("hex");
  }
  seal(text: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.settings.encryptionKey,
      nonce,
    );
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return [nonce, cipher.getAuthTag(), data]
      .map((value) => value.toString("base64"))
      .join(".");
  }
  open(value: string, context: string): string {
    const [nonce, tag, data] = value
      .split(".")
      .map((part) => Buffer.from(part, "base64"));
    if (!nonce || !tag || !data) throw new Error("Invalid encrypted record");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.settings.encryptionKey,
      nonce,
    );
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString(
      "utf8",
    );
  }
}
