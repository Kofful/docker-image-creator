import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import type { Response } from "express";
import {
  AccessTokenGuard,
  type AuthenticatedRequest,
} from "../auth/access-token.guard";
import { AuthOriginGuard } from "../auth/auth-origin.guard";
import { CreateConfigDto } from "./config.dto";
import { ConfigsService } from "./configs.service";
import { GenerationSettings } from "./generation.settings";

@Controller()
@UseGuards(AuthOriginGuard, AccessTokenGuard)
export class ConfigsController {
  constructor(
    private readonly configs: ConfigsService,
    private readonly settings: GenerationSettings,
  ) {}
  @Get("config-input-options")
  @Header("Cache-Control", "no-store")
  inputOptions() {
    return { suppliedEnvironment: this.settings.suppliedEnvironmentEnabled };
  }
  @Post("configs")
  @HttpCode(202)
  @Header("Cache-Control", "no-store")
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateConfigDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = request.get("Idempotency-Key");
    if (
      key !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        key,
      )
    )
      throw new BadRequestException("Idempotency-Key must be a UUID");
    const result = await this.configs.create(
      request.principal.user.id,
      body,
      key,
    );
    response.setHeader("Location", result.statusUrl);
    response.setHeader("Retry-After", "2");
    return result;
  }
  @Get("configs")
  @Header("Cache-Control", "no-store")
  list(@Req() request: AuthenticatedRequest) {
    return this.configs.list(request.principal.user.id);
  }
  @Delete("configs/:id")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  async delete(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = request.get("Idempotency-Key");
    if (
      key !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        key,
      )
    )
      throw new BadRequestException("Idempotency-Key must be a UUID");
    const result = await this.configs.delete(
      request.principal.user.id,
      id,
      key?.toLowerCase(),
    );
    if (result) {
      response.status(202);
      response.setHeader("Location", result.statusUrl);
      response.setHeader("Retry-After", "2");
    }
    return result;
  }
  @Get("configs/:id")
  @Header("Cache-Control", "no-store")
  get(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.configs.get(request.principal.user.id, id);
  }
  @Get("generations/:id")
  @Header("Cache-Control", "no-store")
  generation(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.configs.generation(request.principal.user.id, id);
  }
}
