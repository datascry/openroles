#!/usr/bin/env bun
import { main } from "../src/cli.ts";

main(process.argv).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
