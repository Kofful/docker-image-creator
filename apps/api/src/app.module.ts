import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import { ConfigsModule } from "./configs/configs.module";

@Module({
  imports: [AuthModule, ConfigsModule],
  controllers: [HealthController],
})
export class AppModule {}
