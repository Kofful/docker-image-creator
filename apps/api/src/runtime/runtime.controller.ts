import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { IsUUID } from "class-validator";
import type { Response } from "express";
import type { StartConfigRequest } from "@docker-image-creator/contracts";
import {
  AccessTokenGuard,
  type AuthenticatedRequest,
} from "../auth/access-token.guard";
import { AuthOriginGuard } from "../auth/auth-origin.guard";
import { RuntimeService } from "./runtime.service";

class StartConfigDto implements StartConfigRequest {
  @IsUUID() revisionId!: string;
}
@Controller()
@UseGuards(AuthOriginGuard, AccessTokenGuard)
export class RuntimeController {
  constructor(private readonly runtime: RuntimeService) {}
  private key(request: AuthenticatedRequest): string {
    const value = request.get("Idempotency-Key");
    if (
      !value ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        value,
      )
    )
      throw new BadRequestException("Idempotency-Key must be a UUID");
    return value.toLowerCase();
  }
  @Post("configs/:id/start")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async start(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: StartConfigDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.runtime.submit(
      request.principal.user.id,
      id,
      "start",
      this.key(request),
      body.revisionId,
    );
    response.setHeader("Location", result.statusUrl);
    response.setHeader("Retry-After", "2");
    return result;
  }
  @Post("configs/:id/stop")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async stop(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (
      body !== undefined &&
      (!body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw new BadRequestException("Stop accepts an empty object only");
    const result = await this.runtime.submit(
      request.principal.user.id,
      id,
      "stop",
      this.key(request),
    );
    response.setHeader("Location", result.statusUrl);
    response.setHeader("Retry-After", "2");
    return result;
  }
  @Get("operations/:id")
  @Header("Cache-Control", "no-store")
  operation(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.runtime.operation(request.principal.user.id, id);
  }
  @Get("configs/:id/deployment")
  @Header("Cache-Control", "no-store")
  deployment(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.runtime.deployment(request.principal.user.id, id);
  }
}
