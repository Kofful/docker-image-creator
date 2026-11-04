import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaService } from "../database/prisma.service";
import { GenerationSettings } from "../configs/generation.settings";
import { ArtifactStore } from "../configs/artifact.store";
import { SecretBox } from "../configs/secret-box";
import { DockerRuntimeDriver, RuntimeDriver } from "./runtime.driver";
import { RuntimeSettings, RuntimeWorker } from "./runtime.worker";
import { TerminalService } from "../terminal/terminal.service";
import { TerminalRunner } from "../terminal/terminal.runner";
import { DockerExec } from "../terminal/docker-exec";

@Module({
  providers: [
    PrismaService,
    GenerationSettings,
    SecretBox,
    ArtifactStore,
    RuntimeSettings,
    RuntimeWorker,
    DockerRuntimeDriver,
    { provide: RuntimeDriver, useExisting: DockerRuntimeDriver },
    TerminalService,
    TerminalRunner,
    DockerExec,
  ],
})
class RunnerModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(RunnerModule, {
    logger: false,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  try {
    await app.get(TerminalRunner).listen();
  } catch (error) {
    await app.close();
    throw error;
  }
}
void bootstrap().catch(() => {
  process.stderr.write(
    "Runner startup failed. Check its private configuration.\n",
  );
  process.exitCode = 1;
});
