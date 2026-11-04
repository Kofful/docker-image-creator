import { Injectable } from "@nestjs/common";
import { request } from "node:http";
import type { Socket } from "node:net";

class EngineFailure extends Error {
  constructor(readonly missingShell = false) {
    super("Docker exec failed");
  }
}

// Runner-only Engine client. No shell subprocess, Docker context, or environment files.
@Injectable()
export class DockerExec {
  private options(path: string, method = "GET") {
    return {
      socketPath: "/var/run/docker.sock",
      path: `/v1.48${path}`,
      method,
    };
  }
  async json<T>(path: string, body?: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          ...this.options(path, body ? "POST" : "GET"),
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) req.destroy(new EngineFailure());
            else chunks.push(chunk);
          });
          res.on("error", () => reject(new EngineFailure()));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (!res.statusCode || res.statusCode >= 300)
              return reject(
                new EngineFailure(
                  /executable file not found|stat .*no such file|exec: .*no such file/i.test(
                    text,
                  ),
                ),
              );
            try {
              resolve(text ? (JSON.parse(text) as T) : (undefined as T));
            } catch {
              reject(new EngineFailure());
            }
          });
        },
      );
      req.setTimeout(10000, () => req.destroy(new EngineFailure()));
      req.on("error", () => reject(new EngineFailure()));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async create(
    container: string,
    command: string[],
    tty = true,
  ): Promise<string> {
    const result = await this.json<{ Id: string }>(
      `/containers/${container}/exec`,
      {
        AttachStdin: tty,
        AttachStdout: tty,
        AttachStderr: tty,
        Tty: tty,
        Cmd: command,
        Privileged: false,
        Env: ["TERM=xterm-256color", "BASH_ENV=/dev/null", "ENV=/dev/null"],
        // Omit User/WorkingDir: inherit the container configuration.
      },
    );
    if (!/^[a-f0-9]{64}$/.test(result.Id)) throw new EngineFailure();
    return result.Id;
  }
  async attach(id: string): Promise<{ socket: Socket; head: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({
        ...this.options(`/exec/${id}/start`, "POST"),
        headers: {
          "Content-Type": "application/json",
          Connection: "Upgrade",
          Upgrade: "tcp",
        },
      });
      req.setTimeout(10000, () => req.destroy(new EngineFailure()));
      req.on("upgrade", (_response, socket, head) => {
        req.setTimeout(0);
        socket.setTimeout(0);
        socket.on("error", () => undefined);
        socket.pause();
        resolve({ socket, head });
      });
      req.on("response", (res) => {
        let text = "";
        res.on("data", (data: Buffer) => {
          if (text.length < 4096) text += data.toString("utf8");
        });
        res.on("end", () =>
          reject(
            new EngineFailure(
              /executable file not found|stat .*no such file|exec: .*no such file/i.test(
                text,
              ),
            ),
          ),
        );
      });
      req.on("error", () => reject(new EngineFailure()));
      req.end(JSON.stringify({ Detach: false, Tty: true }));
    });
  }
  async open(container: string, marker: string) {
    for (const shell of ["/bin/bash", "/bin/sh"]) {
      // The fixed startup marker reports the PID in the container's PID namespace.
      // It is consumed by the runner, never displayed as terminal output.
      const id = await this.create(container, [
        shell,
        "-c",
        'printf "\\036%s:%s\\037" "$1" "$$"; exec "$2" -i',
        "terminal",
        marker,
        shell,
      ]);
      try {
        const attached = await this.attach(id);
        const startup = await new Promise<{ pid: number; head: Buffer }>(
          (resolve, reject) => {
            let pending = Buffer.alloc(0);
            let received = false;
            const timer = setTimeout(() => fail(), 5000);
            const dispose = () => {
              clearTimeout(timer);
              attached.socket.off("data", read);
              attached.socket.off("close", fail);
              attached.socket.off("error", fail);
            };
            const fail = () => {
              dispose();
              attached.socket.destroy();
              reject(
                new EngineFailure(
                  /executable file not found|stat .*no such file|exec: .*no such file/i.test(
                    pending.toString("utf8"),
                  ),
                ),
              );
            };
            const read = (chunk: Buffer) => {
              pending = Buffer.concat([pending, chunk]);
              const end = pending.indexOf(0x1f);
              if (end === -1) {
                if (pending.length > 256) fail();
                return;
              }
              const match = pending
                .subarray(0, end)
                .toString("utf8")
                .match(new RegExp(`^\\x1e${marker}:([0-9]+)$`));
              const pid = Number(match?.[1]);
              if (!Number.isSafeInteger(pid) || pid <= 1) {
                fail();
                return;
              }
              received = true;
              dispose();
              attached.socket.pause();
              resolve({ pid, head: pending.subarray(end + 1) });
            };
            attached.socket.on("data", read);
            attached.socket.once("close", fail);
            attached.socket.once("error", fail);
            if (attached.head.length) read(attached.head);
            if (!received && !attached.socket.destroyed)
              attached.socket.resume();
          },
        );
        attached.socket.pause();
        return { id, shell, socket: attached.socket, ...startup };
      } catch (error) {
        if (!(error instanceof EngineFailure) || !error.missingShell)
          throw error;
      }
    }
    throw new EngineFailure(true);
  }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.json(`/exec/${id}/resize?w=${cols}&h=${rows}`, {});
  }
  async running(id: string, container: string): Promise<boolean> {
    const info = await this.json<{ Running: boolean; ContainerID: string }>(
      `/exec/${id}/json`,
    );
    return info.ContainerID === container && info.Running;
  }
  async terminate(container: string, id: string, pid: number): Promise<void> {
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      !(await this.running(id, container))
    )
      return;
    // Signal only this exec's session/foreground process group, never container PID 1.
    // Detached jobs in other sessions may survive, as agreed. All arguments are server-derived.
    const command = [
      "/bin/sh",
      "-c",
      'read -r p comm state ppid pgid sid tty fg rest < "/proc/$1/stat" || exit 0; [ "$sid" = "$1" ] || exit 0; case "$fg" in ""|*[!0-9]*) ;; *) if [ "$fg" -gt 1 ]; then kill -HUP -- "-$fg" 2>/dev/null; kill -KILL -- "-$fg" 2>/dev/null; fi ;; esac; kill -HUP -- "-$1" 2>/dev/null; kill -KILL "$1" 2>/dev/null; exit 0',
      "terminal-cleanup",
      String(pid),
    ];
    const cleanup = await this.create(container, command, false);
    await this.json(`/exec/${cleanup}/start`, { Detach: true, Tty: false });
  }
}

export function shellMissing(error: unknown): boolean {
  return error instanceof EngineFailure && error.missingShell;
}
