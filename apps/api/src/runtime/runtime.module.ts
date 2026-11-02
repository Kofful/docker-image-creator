import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaService } from "../database/prisma.service";
import { RuntimeController } from "./runtime.controller";
import { RuntimeService } from "./runtime.service";

@Module({
  imports: [AuthModule],
  controllers: [RuntimeController],
  providers: [PrismaService, RuntimeService],
})
export class RuntimeModule {}
