import { config } from 'dotenv';

// Source and compiled entry points run with server/ as cwd, while shared settings live above it.
config({ path: '../.env', quiet: true });
