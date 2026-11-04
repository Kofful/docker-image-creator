import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import { ConfigsModule } from "./configs/configs.module";
import { RuntimeModule } from "./runtime/runtime.module";
import { TerminalModule } from "./terminal/terminal.module";

@Module({
  imports: [AuthModule, ConfigsModule, RuntimeModule, TerminalModule],
  controllers: [HealthController],
})
export class AppModule {}
