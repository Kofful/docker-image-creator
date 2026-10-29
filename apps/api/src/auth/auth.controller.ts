import { Body, Controller, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { AuthResponse, AuthUser } from '@docker-image-creator/contracts';
import { AccessTokenGuard, type AuthenticatedRequest } from './access-token.guard';
import { AuthOriginGuard } from './auth-origin.guard';
import { CredentialsDto, RefreshTokenDto } from './auth.dto';
import { AuthService } from './auth.service';

@Controller('auth')
@UseGuards(AuthOriginGuard, ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Header('Cache-Control', 'no-store')
  register(@Body() credentials: CredentialsDto): Promise<AuthResponse> {
    return this.auth.register(credentials);
  }

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  login(@Body() credentials: CredentialsDto): Promise<AuthResponse> {
    return this.auth.login(credentials);
  }

  @Post('refresh_token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  refresh(@Body() body: RefreshTokenDto): Promise<AuthResponse> {
    return this.auth.refresh(body.refresh_token);
  }

  @Get('me')
  @SkipThrottle()
  @UseGuards(AccessTokenGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() request: AuthenticatedRequest): AuthUser {
    return request.principal.user;
  }

  @Post('logout')
  @SkipThrottle()
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  logout(@Req() request: AuthenticatedRequest): Promise<void> {
    return this.auth.logout(request.principal);
  }
}
