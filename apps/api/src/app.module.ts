import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import { ConfigsModule } from "./configs/configs.module";
import { RuntimeModule } from "./runtime/runtime.module";

@Module({
  imports: [AuthModule, ConfigsModule, RuntimeModule],
  controllers: [HealthController],
})
export class AppModule {}
