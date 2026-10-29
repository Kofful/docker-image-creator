import { defineConfig } from 'prisma/config';

// No dotenv import: CLI commands only use explicitly provided process variables.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'mysql://unused:unused@127.0.0.1:3306/unused',
  },
});
