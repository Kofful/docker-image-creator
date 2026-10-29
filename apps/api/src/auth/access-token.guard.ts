import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type AuthPrincipal } from './auth.service';

export type AuthenticatedRequest = Request & { principal: AuthPrincipal };

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.get('authorization');
    const match = header?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i);
    if (!match?.[1] || match[1].length > 4096) {
      throw new UnauthorizedException('Bearer access token required');
    }
    request.principal = await this.auth.authenticate(match[1]);
    return true;
  }
}
