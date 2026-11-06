import { Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConfigServiceInput,
  ComposeGenerationRequirements,
  ComposeRevisionMetadata,
  ServiceRuntimeResponse,
} from "@docker-image-creator/contracts";
import { CATALOG } from "../configs/image.catalog";
import { validateSavedCompose } from "../configs/compose.validator";
import { composeIdentity } from "../configs/compose.revision";
import { runtimeLabels } from "./runtime.manifest";
import { containerStates, unknownService } from "./runtime.observations";

export class RuntimeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface RuntimeTarget {
  userId: string;
  configId: string;
  revisionId: string;
  services: ConfigServiceInput[];
  manifest: string;
  digest: string;
  metadata: ComposeRevisionMetadata;
  requirements: ComposeGenerationRequirements;
  secrets: Record<string, string>;
}
export interface RuntimeObservation {
  running: boolean | undefined;
  ready: boolean;
  services: ServiceRuntimeResponse[];
}
export abstract class RuntimeDriver {
  abstract start(target: RuntimeTarget, signal: AbortSignal): Promise<void>;
  abstract remove(target: RuntimeTarget, signal: AbortSignal): Promise<void>;
  abstract stop(target: RuntimeTarget, signal: AbortSignal): Promise<void>;
  abstract observe(
    target: RuntimeTarget,
    signal: AbortSignal,
  ): Promise<RuntimeObservation>;
}
interface Container {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: {
    Status: string;
    Running: boolean;
    Restarting: boolean;
    Health?: { Status: string };
  };
  NetworkSettings: {
    Networks: Record<string, unknown>;
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
  HostConfig: {
    Privileged: boolean;
    NetworkMode: string;
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop?: string[];
    RestartPolicy: { Name: string };
  };
  Mounts: { Type: string; Name?: string; Destination: string }[];
}

// This provider is registered only by the runner bootstrap, never by the API.
@Injectable()
export class DockerRuntimeDriver extends RuntimeDriver {
  async terminalContainer(
    target: RuntimeTarget,
    service: string,
  ): Promise<string> {
    const signal = AbortSignal.timeout(15000);
    const rows = await this.containers(target, signal);
    const row = rows.find(
      (item) => item.Config.Labels["com.docker.compose.service"] === service,
    );
    if (
      !row ||
      row.State.Status !== "running" ||
      !row.State.Running ||
      row.State.Restarting
    )
      throw new RuntimeFailure("CONTAINER_UNAVAILABLE");
    await this.network(target, signal);
    return row.Id;
  }
  protected async command(
    args: string[],
    signal: AbortSignal,
    input?: string,
    secrets: Record<string, string> = {},
    ms = 15000,
  ): Promise<string> {
    signal.throwIfAborted();
    if (
      Object.keys(secrets).some((key) => !/^DIC_SECRET_[a-f0-9]{32}$/.test(key))
    )
      throw new RuntimeFailure("INVALID_REVISION");
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        // No inherited tokens, Docker contexts, Compose overrides, or env-file loading.
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          DOCKER_HOST: "unix:///var/run/docker.sock",
          COMPOSE_DISABLE_ENV_FILE: "1",
          ...secrets,
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        // The Docker CLI launches Compose as a child. Kill the entire command group.
        detached: true,
      });
      let output = "";
      let failed = false;
      const abort = () => {
        failed = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The command group already exited. */
        }
      };
      const timer = setTimeout(abort, ms);
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (data: Buffer) => {
        if (Buffer.byteLength(output) + data.length > 1024 * 1024) abort();
        else output += data.toString("utf8");
      });
      // Compose errors and inspect output may contain secrets. Never retain stderr.
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.once("error", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new RuntimeFailure("DOCKER_UNAVAILABLE"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (code === 0 && !failed && !signal.aborted) resolve(output.trim());
        else reject(new RuntimeFailure("DOCKER_UNAVAILABLE"));
      });
      child.stdin.end(input);
    });
  }
  private owned(
    labels: Record<string, string> | undefined,
    target: RuntimeTarget,
  ): void {
    for (const [key, value] of Object.entries(
      runtimeLabels(target.userId, target.configId),
    ))
      if (labels?.[key] !== value)
        throw new RuntimeFailure("RESOURCE_CONFLICT");
  }
  private project(target: RuntimeTarget): string {
    for (const id of [target.userId, target.configId, target.revisionId])
      if (!/^[a-f0-9-]{36}$/i.test(id))
        throw new RuntimeFailure("INVALID_REVISION");
    return `dic-${target.configId}`;
  }
  private async containers(
    target: RuntimeTarget,
    signal: AbortSignal,
    selectedIds?: string[],
  ): Promise<Container[]> {
    const project = this.project(target);
    const ids =
      selectedIds ??
      (
        await this.command(
          [
            "ps",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            `label=com.docker.compose.project=${project}`,
          ],
          signal,
        )
      )
        .split(/\s+/)
        .filter(Boolean);
    if (
      ids.length > target.services.length ||
      ids.some((id) => !/^[a-f0-9]{64}$/.test(id))
    )
      throw new RuntimeFailure("RESOURCE_CONFLICT");
    if (!ids.length) return [];
    const rows = JSON.parse(
      await this.command(["inspect", ...ids], signal),
    ) as Container[];
    if (rows.length !== ids.length || rows.some((row) => !ids.includes(row.Id)))
      throw new RuntimeFailure("RESOURCE_CONFLICT");
    const names = new Set<string>();
    for (const row of rows) {
      this.owned(row.Config.Labels, target);
      const name = row.Config.Labels["com.docker.compose.service"];
      const service = target.services.find((item) => item.name === name);
      if (
        !service ||
        names.has(service.name) ||
        row.Config.Image !== CATALOG[service.image].image ||
        row.Config.Labels["docker-image-creator.revision"] !==
          target.revisionId ||
        row.HostConfig.Privileged ||
        row.HostConfig.NetworkMode !== `${project}_stack` ||
        row.HostConfig.Memory !== 512 * 1024 * 1024 ||
        row.HostConfig.NanoCpus !== 500000000 ||
        row.HostConfig.PidsLimit !== 128 ||
        row.HostConfig.RestartPolicy.Name !== "no" ||
        // Engine inspect may return the canonical CAP_ prefix.
        !row.HostConfig.CapDrop?.some(
          (capability) =>
            capability === "NET_RAW" || capability === "CAP_NET_RAW",
        ) ||
        (row.State.Running &&
          Object.keys(row.NetworkSettings.Networks).length !== 1) ||
        Object.keys(row.NetworkSettings.Networks).some(
          (network) => network !== `${project}_stack`,
        )
      )
        throw new RuntimeFailure("RESOURCE_CONFLICT");
      if (row.State.Running) {
        const mappings = Object.values(row.NetworkSettings.Ports).flatMap(
          (value) => value ?? [],
        );
        if (mappings.length) throw new RuntimeFailure("RESOURCE_CONFLICT");
      }
      names.add(service.name);
      const metadata = target.metadata.services.find(
        (entry) => entry.name === service.name,
      );
      if (!metadata) throw new RuntimeFailure("INVALID_REVISION");
      const expected = new Map(
        metadata.volumes.map((volume) => [
          `${project}_${volume.source}`,
          volume.target,
        ]),
      );
      if (
        row.Mounts.length !== expected.size ||
        row.Mounts.some(
          (mount) =>
            mount.Type !== "volume" ||
            !mount.Name ||
            expected.get(mount.Name) !== mount.Destination,
        )
      )
        throw new RuntimeFailure("RESOURCE_CONFLICT");
    }
    return rows;
  }
  private async network(
    target: RuntimeTarget,
    signal: AbortSignal,
    allowedContainers?: Set<string>,
  ): Promise<string | undefined> {
    const name = `${this.project(target)}_stack`;
    const id = await this.command(
      ["network", "ls", "--quiet", "--no-trunc", "--filter", `name=^${name}$`],
      signal,
    );
    if (!id) return;
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new RuntimeFailure("RESOURCE_CONFLICT");
    const rows = JSON.parse(
      await this.command(["network", "inspect", id], signal),
    ) as {
      Containers?: Record<string, unknown>;
      Internal: boolean;
      Driver: string;
      EnableIPv6: boolean;
      Labels: Record<string, string>;
      Options: Record<string, string>;
    }[];
    if (
      rows.length !== 1 ||
      !rows[0]!.Internal ||
      rows[0]!.Driver !== "bridge" ||
      rows[0]!.EnableIPv6 ||
      rows[0]!.Options["com.docker.network.bridge.gateway_mode_ipv4"] !==
        "isolated"
    )
      throw new RuntimeFailure("RESOURCE_CONFLICT");
    this.owned(rows[0]!.Labels, target);
    if (
      allowedContainers &&
      (!rows[0]!.Containers ||
        Object.keys(rows[0]!.Containers).some(
          (id) => !allowedContainers.has(id),
        ))
    )
      throw new RuntimeFailure("RESOURCE_CONFLICT");
    return id;
  }
  async remove(target: RuntimeTarget, signal: AbortSignal): Promise<void> {
    const rows = await this.containers(target, signal);
    if (rows.some((row) => row.State.Running || row.State.Restarting))
      throw new RuntimeFailure("DELETE_FAILED");
    await this.network(target, signal, new Set(rows.map((row) => row.Id)));
    // No force or volume flags: Docker refuses a container that started since inspection.
    for (const row of rows) await this.command(["rm", row.Id], signal);
    const network = await this.network(target, signal, new Set());
    if (network) await this.command(["network", "rm", network], signal);
    if (
      (await this.containers(target, signal)).length ||
      (await this.network(target, signal))
    )
      throw new RuntimeFailure("DELETE_FAILED");
  }
  async observe(
    target: RuntimeTarget,
    signal: AbortSignal,
  ): Promise<RuntimeObservation> {
    const project = this.project(target);
    // Include the service label so an isolated inspect failure can be attributed
    // without trusting or publishing any failed container's inspect data.
    const listed = await this.command(
      [
        "ps",
        "--all",
        "--no-trunc",
        "--format",
        '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ],
      signal,
    );
    const entries = listed
      ? listed.split("\n").map((line) => line.split("\t"))
      : [];
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const [id, name, extra] of entries) {
      if (
        !id ||
        !/^[a-f0-9]{64}$/.test(id) ||
        !name ||
        extra !== undefined ||
        names.has(name) ||
        ids.has(id) ||
        !target.services.some((service) => service.name === name)
      )
        throw new RuntimeFailure("RESOURCE_CONFLICT");
      names.add(name);
      ids.add(id);
    }
    await this.network(target, signal);
    const services: ServiceRuntimeResponse[] = [];
    for (const service of target.services) {
      const unknown = unknownService(service);
      const entry = entries.find(([, name]) => name === service.name);
      if (!entry) {
        services.push({
          ...unknown,
          state: "not_created",
          observedAt: new Date().toISOString(),
        });
        continue;
      }
      try {
        const rows = await this.containers(target, signal, [entry[0]!]);
        const row = rows[0]!;
        if (
          row.Config.Labels["com.docker.compose.service"] !== service.name ||
          !containerStates.has(
            row.State.Status as ServiceRuntimeResponse["state"],
          ) ||
          ["unknown", "not_created"].includes(row.State.Status) ||
          ["running", "paused", "restarting"].includes(row.State.Status) !==
            row.State.Running
        )
          throw new RuntimeFailure("RESOURCE_CONFLICT");
        const health = row.State.Health?.Status;
        services.push({
          ...unknown,
          state: row.State.Status as ServiceRuntimeResponse["state"],
          health:
            health === "starting" ||
            health === "healthy" ||
            health === "unhealthy"
              ? health
              : null,
          publishedPort: null,
          observedAt: new Date().toISOString(),
        });
      } catch {
        signal.throwIfAborted();
        services.push(unknown);
      }
    }
    const uncertain = services.some((service) => service.state === "unknown");
    const running = services.some((service) =>
      ["running", "restarting", "paused", "removing"].includes(service.state),
    );
    return {
      running: running ? true : uncertain ? undefined : false,
      ready: services.every(
        (service) =>
          service.state === "running" && service.health === "healthy",
      ),
      services,
    };
  }
  async start(target: RuntimeTarget, signal: AbortSignal): Promise<void> {
    try {
      const expected = composeIdentity(
        target.userId,
        target.configId,
        target.revisionId,
      );
      if (
        Object.entries(expected).some(
          ([key, value]) =>
            target.requirements.identity[key as keyof typeof expected] !==
            value,
        )
      )
        throw new Error();
      validateSavedCompose(
        target.metadata,
        target.manifest,
        target.digest,
        target.requirements,
      );
      if (
        JSON.stringify(target.services) !==
        JSON.stringify(target.requirements.services)
      )
        throw new Error();
      const references = target.requirements.environment
        .map((entry) => entry.reference)
        .sort();
      if (
        JSON.stringify(Object.keys(target.secrets).sort()) !==
          JSON.stringify(references) ||
        Object.values(target.secrets).some(
          (value) =>
            typeof value !== "string" ||
            !value.length ||
            Buffer.byteLength(value) > 4096 ||
            /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
              value,
            ),
        ) ||
        Object.values(target.secrets).reduce(
          (sum, value) => sum + Buffer.byteLength(value),
          0,
        ) > 16384
      )
        throw new Error();
    } catch {
      throw new RuntimeFailure("INVALID_REVISION");
    }
    const project = this.project(target);
    const info = JSON.parse(
      await this.command(["info", "--format", "{{json .}}"], signal),
    ) as {
      ServerVersion: string;
      OSType: string;
      MemoryLimit: boolean;
      PidsLimit: boolean;
      CpuCfsQuota: boolean;
    };
    if (
      !/^\d+\./.test(info.ServerVersion) ||
      Number(info.ServerVersion.split(".")[0]) < 28 ||
      info.OSType !== "linux" ||
      !info.MemoryLimit ||
      !info.PidsLimit ||
      !info.CpuCfsQuota
    )
      throw new RuntimeFailure("UNSUPPORTED_DOCKER");
    const existing = await this.containers(target, signal);
    if (existing.some((row) => row.State.Running || row.State.Restarting))
      throw new RuntimeFailure("RESOURCE_CONFLICT");
    await this.network(target, signal);
    for (const service of target.services) {
      const metadata = target.metadata.services.find(
        (entry) => entry.name === service.name,
      )!;
      for (const volume of metadata.volumes) {
        const name = `${project}_${volume.source}`;
        const found = await this.command(
          ["volume", "ls", "--quiet", "--filter", `name=^${name}$`],
          signal,
        );
        if (found) {
          const rows = JSON.parse(
            await this.command(["volume", "inspect", name], signal),
          ) as { Labels: Record<string, string> }[];
          this.owned(rows[0]?.Labels, target);
        }
      }
    }
    // Empty private project directory and explicit null env-file prevent implicit repo reads.
    const directory = await mkdtemp(join(tmpdir(), "dic-runner-"));
    try {
      const base = [
        "compose",
        "--env-file",
        "/dev/null",
        "--project-directory",
        directory,
        "--project-name",
        project,
        "--file",
        "-",
      ];
      await this.command(
        [...base, "pull", "--quiet"],
        signal,
        target.manifest,
        target.secrets,
        5 * 60000,
      ).catch(() => {
        throw new RuntimeFailure("IMAGE_PULL_FAILED");
      });
      await this.command(
        [
          ...base,
          "up",
          "--detach",
          "--no-build",
          "--pull",
          "never",
          "--wait",
          "--wait-timeout",
          "120",
        ],
        signal,
        target.manifest,
        target.secrets,
        150000,
      ).catch(() => {
        throw new RuntimeFailure("START_FAILED");
      });
      if (!(await this.observe(target, signal)).ready)
        throw new RuntimeFailure("START_FAILED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async stop(target: RuntimeTarget, signal: AbortSignal): Promise<void> {
    const rows = await this.containers(target, signal);
    for (const row of rows)
      if (row.State.Running || row.State.Restarting)
        await this.command(
          ["stop", "--time", "30", row.Id],
          signal,
          undefined,
          {},
          35000,
        );
    if ((await this.observe(target, signal)).running !== false)
      throw new RuntimeFailure("STOP_FAILED");
  }
}
