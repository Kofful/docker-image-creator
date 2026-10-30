import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaService } from "../database/prisma.service";
import { ConfigsController } from "./configs.controller";
import { ConfigsService } from "./configs.service";
import { GenerationSettings } from "./generation.settings";
import { SecretBox } from "./secret-box";
import { ArtifactStore } from "./artifact.store";
import {
  FakeGenerationProvider,
  GenerationProvider,
} from "./generation.provider";
import { GenerationWorker } from "./generation.worker";

@Module({
  imports: [AuthModule],
  controllers: [ConfigsController],
  providers: [
    PrismaService,
    ConfigsService,
    GenerationSettings,
    SecretBox,
    ArtifactStore,
    GenerationWorker,
    { provide: GenerationProvider, useClass: FakeGenerationProvider },
  ],
})
export class ConfigsModule {}
