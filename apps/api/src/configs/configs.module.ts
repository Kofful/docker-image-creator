import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaService } from "../database/prisma.service";
import { ConfigsController } from "./configs.controller";
import { ConfigsService } from "./configs.service";
import { GenerationSettings } from "./generation.settings";
import { SecretBox } from "./secret-box";
import { ArtifactStore } from "./artifact.store";
import { ConfigArtifactCleanup } from "./config-artifact-cleanup";
import { GenerationWorker } from "./generation.worker";
import { ComposeGenerationProvider } from "./compose.provider";
import { OpenRouterGenerationProvider } from "./openrouter.provider";
import { ComposeGenerator } from "./compose.generator";

@Module({
  imports: [AuthModule],
  controllers: [ConfigsController],
  providers: [
    PrismaService,
    ConfigsService,
    GenerationSettings,
    SecretBox,
    ArtifactStore,
    ConfigArtifactCleanup,
    GenerationWorker,
    ComposeGenerator,
    {
      provide: ComposeGenerationProvider,
      useFactory: () =>
        new OpenRouterGenerationProvider({
          apiKey: process.env.OPENROUTER_API_KEY,
        }),
    },
  ],
})
export class ConfigsModule {}
