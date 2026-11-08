import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ComposeIdentity } from "@docker-image-creator/contracts";
import { ComposeProviderFailure } from "./compose.provider";

const MASK = "[REDACTED]";
const SECRET_KEY =
  /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie|^pwd$/i;
const REFERENCE = /^\$\{DIC_SECRET_[a-f0-9]{32}:\?Required value\}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Redact structured fields and embedded prompt/YAML/code strings, without executing YAML. */
export function redactBody(text: string, secrets: readonly string[]): unknown {
  let nodes = 0;
  const scrub = (value: string): string => {
    for (const secret of secrets.filter(Boolean)) {
      for (const form of [
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret),
      ])
        value = value.split(form).join(MASK);
    }
    value = value
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        MASK,
      )
      .replace(/\bBearer\s+[^\s"'<>]+/gi, `Bearer ${MASK}`)
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, `$1${MASK}@`);
    // Mask a complete assignment line, including shell/SQL/JSON fragments.
    // For YAML block scalars also mask subsequent indented lines.
    let blockIndent: number | undefined;
    return value
      .split("\n")
      .map((line) => {
        const indent = line.length - line.trimStart().length;
        if (blockIndent !== undefined && (indent > blockIndent || !line.trim()))
          return MASK;
        blockIndent = undefined;
        for (const match of line.matchAll(
          /(^|[^\w.-])([\w.-]+["']?\s*[:=]\s*)/g,
        )) {
          const assignment = match[2]!;
          const key = assignment.replace(/["']?\s*[:=]\s*$/, "");
          if (!SECRET_KEY.test(key)) continue;
          const end = match.index + match[0].length;
          const rest = line.slice(end);
          if (REFERENCE.test(rest.trim().replace(/^["']|["']$/g, ""))) continue;
          if (!rest.trim() || /^[|>][+-]?\s*$/.test(rest.trim()))
            blockIndent = indent;
          return line.slice(0, end) + MASK;
        }
        return line;
      })
      .join("\n");
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 48) return "[REDACTED: structure limit]";
    if (typeof value === "string") {
      const first = value.trimStart()[0];
      if (first === "[" || first === "{") {
        try {
          return JSON.stringify(walk(JSON.parse(value), depth + 1));
        } catch {
          /* Keep malformed text. */
        }
      }
      return scrub(value);
    }
    if (Array.isArray(value))
      return value
        .slice(0, Math.max(0, 100000 - nodes))
        .map((entry) => walk(entry, depth + 1));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, Math.max(0, 100000 - nodes))
          .map(([key, entry]) => [
            scrub(key),
            SECRET_KEY.test(key) &&
            !(
              typeof entry === "number" &&
              /^(max_tokens|max_completion_tokens|prompt_tokens|completion_tokens|total_tokens|cached_tokens|reasoning_tokens)$/.test(
                key,
              )
            ) &&
            !(typeof entry === "string" && REFERENCE.test(entry))
              ? MASK
              : walk(entry, depth + 1),
          ]),
      );
    return value;
  };
  // Parse first so JSON escapes cannot conceal a credential field or known key.
  try {
    return walk(JSON.parse(text), 0);
  } catch {
    return scrub(text);
  }
}

export interface LlmBodyRecord {
  identity: ComposeIdentity;
  requestId: string;
  attempt: number;
  direction: "request" | "response";
  body: string | null;
  status?: number;
  complete: boolean;
  truncated: boolean;
  bytes: number;
  failure?: string;
}

export interface LlmBodyLogger {
  write(record: LlmBodyRecord, secrets: readonly string[]): Promise<void>;
}

export function bodyLogDirectory(identity: ComposeIdentity): string {
  const ids = [identity.userId, identity.configId, identity.revisionId];
  if (!ids.every((id) => UUID.test(id))) throw new Error("INVALID_LOG_SCOPE");
  return ids.join("/");
}

/** Private, exclusive files; no body, credentials or filesystem exceptions reach stdout. */
export class FileLlmBodyLogger implements LlmBodyLogger {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  async write(
    record: LlmBodyRecord,
    secrets: readonly string[],
  ): Promise<void> {
    try {
      const scope = bodyLogDirectory(record.identity);
      if (
        !UUID.test(record.requestId) ||
        !Number.isInteger(record.attempt) ||
        record.attempt < 1 ||
        record.attempt > 3 ||
        !["request", "response"].includes(record.direction)
      )
        throw new Error("INVALID_LOG_RECORD");
      let ancestor = this.root;
      while (true) {
        try {
          await lstat(ancestor);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          ancestor = dirname(ancestor);
        }
      }
      if ((await realpath(ancestor)) !== ancestor)
        throw new Error("INVALID_LOG_ROOT");
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if ((await realpath(this.root)) !== this.root)
        throw new Error("INVALID_LOG_ROOT");
      await chmod(this.root, 0o700);
      let directory = this.root;
      for (const id of scope.split("/")) {
        directory = join(directory, id);
        await mkdir(directory, { mode: 0o700 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("INVALID_LOG_DIRECTORY");
        await chmod(directory, 0o700);
      }
      const path = join(
        directory,
        `${record.requestId}-${record.attempt}.${record.direction}.json`,
      );
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(
          JSON.stringify(
            {
              version: 2,
              ...record,
              identity: {
                userId: record.identity.userId,
                configId: record.identity.configId,
                revisionId: record.identity.revisionId,
                projectName: `dic-${record.identity.configId}`,
              },
              timestamp: new Date().toISOString(),
              body:
                record.body === null ? null : redactBody(record.body, secrets),
            },
            null,
            2,
          ) + "\n",
        );
        await handle.sync();
      } catch (error) {
        await unlink(path).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
    } catch {
      throw new ComposeProviderFailure("PROVIDER_LOG_FAILED");
    }
  }
}
