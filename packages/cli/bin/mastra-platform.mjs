#!/usr/bin/env node
// Node strips the TypeScript types itself; the sources sit outside node_modules.
import { main } from '../src/main.ts';
main(process.argv.slice(2)).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
