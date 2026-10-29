import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import type { AuthResponse, AuthUser } from '@docker-image-creator/contracts';
import { Prisma, type Session } from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthConfig } from './auth.config';
import type { CredentialsDto } from './auth.dto';

export interface AuthPrincipal {
  user: AuthUser;
  sessionId: string;
}

interface AccessClaims {
  sub: string;
  sid: string;
  type: 'access';
  exp: number;
}

@Injectable()
export class AuthService {
  // Unknown accounts perform the same password verification as known accounts.
  private readonly dummyHash = this.hashPassword(randomBytes(32).toString('hex'));

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AuthConfig,
  ) {}

  async register(credentials: CredentialsDto): Promise<AuthResponse> {
    const passwordHash = await this.hashPassword(credentials.password);
    const user = { id: randomUUID(), email: credentials.email };
    const session = this.newSession(user.id);
    const tokens = this.issueTokens(user, session);
    try {
      await this.prisma.user.create({
        data: {
          ...user,
          passwordHash,
          sessions: {
            create: {
              id: session.id,
              expiresAt: session.expiresAt,
              refreshTokens: {
                create: { id: randomUUID(), tokenHash: this.hashToken(tokens.refresh_token) },
              },
            },
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }
    return tokens;
  }

  async login(credentials: CredentialsDto): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: credentials.email } });
    const valid = await argon2.verify(
      user?.passwordHash ?? (await this.dummyHash),
      credentials.password,
    );
    if (!user || !valid) throw new UnauthorizedException('Invalid email or password');
    const session = this.newSession(user.id);
    const tokens = this.issueTokens(user, session);
    await this.prisma.session.create({
      data: {
        ...session,
        refreshTokens: {
          create: { id: randomUUID(), tokenHash: this.hashToken(tokens.refresh_token) },
        },
      },
    });
    return tokens;
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const result = await this.prisma.$transaction(
      async (transaction) => {
        const token = await transaction.refreshToken.findUnique({
          where: { tokenHash: this.hashToken(refreshToken) },
          include: { session: { include: { user: true } } },
        });
        const now = new Date();
        if (!token || token.session.revokedAt || token.session.expiresAt <= now) return null;

        // A conditional write serializes consumers of the same refresh token.
        const consumed = await transaction.refreshToken.updateMany({
          where: { id: token.id, usedAt: null },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) {
          // Return normally so revocation commits before the HTTP 401 is thrown.
          await transaction.session.update({
            where: { id: token.sessionId },
            data: { revokedAt: now },
          });
          return null;
        }
        const tokens = this.issueTokens(token.session.user, token.session);
        await transaction.refreshToken.create({
          data: {
            id: randomUUID(),
            sessionId: token.sessionId,
            tokenHash: this.hashToken(tokens.refresh_token),
          },
        });
        return tokens;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (!result) throw new UnauthorizedException('Invalid refresh token');
    return result;
  }

  async authenticate(accessToken: string): Promise<AuthPrincipal> {
    let claims: AccessClaims;
    try {
      claims = this.jwt.verify<AccessClaims>(accessToken, {
        secret: this.config.secret,
        algorithms: ['HS256'],
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      if (
        claims.type !== 'access' ||
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string' ||
        !Number.isFinite(claims.exp)
      ) {
        throw new Error('Invalid access claims');
      }
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    const session = await this.prisma.session.findFirst({
      where: {
        id: claims.sid,
        userId: claims.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!session) throw new UnauthorizedException('Invalid access token');
    return { user: session.user, sessionId: session.id };
  }

  async logout(principal: AuthPrincipal): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: principal.sessionId, userId: principal.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private newSession(userId: string): Pick<Session, 'id' | 'userId' | 'expiresAt'> {
    return {
      id: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + this.config.refreshTokenSeconds * 1000),
    };
  }

  private issueTokens(user: AuthUser, session: Pick<Session, 'id' | 'expiresAt'>): AuthResponse {
    const expiresIn = Math.min(
      this.config.accessTokenSeconds,
      Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
    );
    return {
      user: { id: user.id, email: user.email },
      access_token: this.jwt.sign(
        { sub: user.id, sid: session.id, type: 'access' },
        {
          secret: this.config.secret,
          algorithm: 'HS256',
          issuer: this.config.issuer,
          audience: this.config.audience,
          jwtid: randomUUID(),
          expiresIn,
        },
      ),
      refresh_token: randomBytes(32).toString('base64url'),
      token_type: 'Bearer',
      expires_in: expiresIn,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private hashPassword(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }
}
