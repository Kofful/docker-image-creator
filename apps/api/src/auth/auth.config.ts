import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthConfig {
  readonly accessTokenSeconds = 15 * 60;
  readonly refreshTokenSeconds = 7 * 24 * 60 * 60;
  readonly issuer = 'docker-image-creator-api';
  readonly audience = 'docker-image-creator';
  readonly secret: string;
  readonly trustedOrigins: ReadonlySet<string>;

  constructor() {
    const secret = process.env.AUTH_ACCESS_TOKEN_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new Error('AUTH_ACCESS_TOKEN_SECRET must contain at least 32 bytes');
    }
    this.secret = secret;
    const origins = process.env.AUTH_TRUSTED_ORIGINS;
    if (!origins) throw new Error('AUTH_TRUSTED_ORIGINS is required');
    this.trustedOrigins = new Set(
      origins.split(',').map((value) => {
        const url = new URL(value.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.trim()) {
          throw new Error('AUTH_TRUSTED_ORIGINS must contain exact HTTP(S) origins');
        }
        return url.origin;
      }),
    );
  }
}
