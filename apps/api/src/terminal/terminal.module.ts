import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaService } from "../database/prisma.service";
import { TerminalController } from "./terminal.controller";
import { TerminalService } from "./terminal.service";
import { TerminalGateway } from "./terminal.gateway";

@Module({
  imports: [AuthModule],
  controllers: [TerminalController],
  providers: [PrismaService, TerminalService, TerminalGateway],
})
export class TerminalModule {}
