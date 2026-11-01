import { Injectable } from "@nestjs/common";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { GenerationSettings } from "./generation.settings";

@Injectable()
export class ArtifactStore {
  constructor(private readonly settings: GenerationSettings) {}
  private async directory(
    userId: string,
    configId: string,
    revisionId: string,
  ): Promise<string> {
    for (const id of [userId, configId, revisionId])
      if (!/^[a-f0-9-]{36}$/.test(id))
        throw new Error("Invalid server identity");
    await mkdir(this.settings.root, { recursive: true, mode: 0o700 });
    // Refuse symlink roots/ancestors, even if supplied by deployment configuration.
    if ((await realpath(this.settings.root)) !== this.settings.root)
      throw new Error("Artifact root contains a symlink");
    let directory = this.settings.root;
    for (const id of [userId, configId, revisionId]) {
      directory = join(directory, id);
      await mkdir(directory, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Invalid artifact directory");
    }
    return directory;
  }
  async write(
    userId: string,
    configId: string,
    revisionId: string,
    content: string,
  ): Promise<string> {
    const directory = await this.directory(userId, configId, revisionId);
    const temporary = join(directory, "compose.pending");
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, "compose.yaml"));
    return [userId, configId, revisionId, "compose.yaml"].join("/");
  }
  async remove(
    userId: string,
    configId: string,
    revisionId: string,
  ): Promise<void> {
    await this.removeDirectory([userId, configId, revisionId]);
  }
  async removeConfig(userId: string, configId: string): Promise<void> {
    await this.removeDirectory([userId, configId]);
  }
  private async removeDirectory(ids: string[]): Promise<void> {
    for (const id of ids)
      if (!/^[a-f0-9-]{36}$/.test(id))
        throw new Error("Invalid server identity");
    // Missing artifacts are already clean. Never create paths during cleanup.
    try {
      if ((await realpath(this.settings.root)) !== this.settings.root)
        throw new Error("Artifact root contains a symlink");
      let directory = this.settings.root;
      for (const id of ids) {
        directory = join(directory, id);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Invalid artifact directory");
      }
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
