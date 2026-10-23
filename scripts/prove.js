#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const files = fs
  .readdirSync(path.join(root, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(root, "test", name));
const result = spawnSync(process.execPath, ["--test", "--test-reporter", "spec", ...files], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(result.error.message + "\n");
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
