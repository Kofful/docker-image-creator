import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthConfig } from './auth.config';

@Injectable()
export class AuthOriginGuard implements CanActivate {
  constructor(private readonly config: AuthConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.get('origin');
    if (
      (origin !== undefined && !this.config.trustedOrigins.has(origin)) ||
      request.get('sec-fetch-site') === 'cross-site'
    ) {
      throw new ForbiddenException('Untrusted request origin');
    }
    return true;
  }
}
