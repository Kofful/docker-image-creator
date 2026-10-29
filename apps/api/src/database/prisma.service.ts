import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    let url: URL;
    try {
      url = new URL(databaseUrl);
    } catch {
      throw new Error('DATABASE_URL must be a valid MySQL URL');
    }
    if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must use MySQL');
    if (url.search || url.hash) {
      throw new Error('DATABASE_URL query options and fragments are not supported');
    }
    if (!url.hostname || !url.username || url.pathname.length < 2) {
      throw new Error('DATABASE_URL must include a host, user, and database');
    }
    super({
      adapter: new PrismaMariaDb({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: 5,
        connectTimeout: 5000,
        acquireTimeout: 5000,
        timezone: '+00:00',
        // MySQL 8 caching_sha2_password on the private local infrastructure network.
        allowPublicKeyRetrieval: true,
        logParam: false,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
