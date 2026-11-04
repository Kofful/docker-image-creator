import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  AccessTokenGuard,
  type AuthenticatedRequest,
} from "../auth/access-token.guard";
import { AuthOriginGuard } from "../auth/auth-origin.guard";
import { TerminalService } from "./terminal.service";

@Controller("configs/:id/services/:service/terminal-tickets")
@UseGuards(AuthOriginGuard, AccessTokenGuard)
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}
  @Post()
  @Header("Cache-Control", "no-store")
  issue(
    @Req() request: AuthenticatedRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("service") service: string,
    @Body() body: unknown,
  ) {
    if (
      !/^[a-z][a-z0-9-]{0,39}$/.test(service) ||
      (body !== undefined &&
        (!body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length))
    )
      throw new BadRequestException();
    return this.terminal.issue(request.principal, id, service);
  }
}
