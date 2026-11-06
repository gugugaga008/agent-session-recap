#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).then((code) => {
  if (typeof code === "number" && code !== 0) process.exitCode = code;
});
