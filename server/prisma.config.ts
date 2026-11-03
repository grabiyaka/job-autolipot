import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '../.env', quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://framework:framework_demo@localhost:5547/framework_demo',
  },
});
