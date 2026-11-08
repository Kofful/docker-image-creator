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
import { OpenAICompatibleGenerationProvider } from "./openai-compatible.provider";
import { FileLlmBodyLogger } from "./llm-body-log";
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
      inject: [GenerationSettings],
      useFactory: (settings: GenerationSettings) =>
        new OpenAICompatibleGenerationProvider({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: process.env.OPENAI_BASE_URL,
          model: process.env.OPENAI_MODEL,
          bodyLog: new FileLlmBodyLogger(settings.llmLogRoot),
        }),
    },
  ],
})
export class ConfigsModule {}
