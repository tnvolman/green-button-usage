"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function findNamed(dir, name, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findNamed(full, name, out);
    else if (entry.name === name) out.push(full);
  }
  return out;
}

test("every mcp.json uses CURSOR_PLUGIN_ROOT for paths and cwd", () => {
  const files = findNamed(root, "mcp.json", []);
  assert.ok(files.length >= 1);
  for (const file of files) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const servers = config.mcpServers;
    assert.equal(servers && typeof servers === "object" && !Array.isArray(servers), true, file);
    const names = Object.keys(servers);
    assert.ok(names.length >= 1, file);
    for (const name of names) {
      const server = servers[name];
      assert.equal(server.cwd, "${CURSOR_PLUGIN_ROOT}", file + " " + name);
      assert.ok(Array.isArray(server.args), file + " " + name);
      const paths = server.args.filter((arg) => typeof arg === "string" && (arg.includes("/") || arg.includes("\\")));
      assert.ok(paths.length >= 1, file + " " + name);
      for (const arg of paths) {
        assert.equal(arg.includes("${CURSOR_PLUGIN_ROOT}"), true, arg);
      }
      if (typeof server.command === "string" && (server.command.includes("/") || server.command.includes("\\"))) {
        assert.equal(server.command.includes("${CURSOR_PLUGIN_ROOT}"), true, server.command);
      }
    }
  }
});

test("plugin.json names Michael McClanahan and the MIT license file is present", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  assert.equal(plugin.author && plugin.author.name, "Michael McClanahan");
  assert.equal(plugin.license, "MIT");
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  assert.match(license, /^MIT License\n/);
  assert.match(license, /Copyright \(c\) 2026 /);
  assert.match(license, /Permission is hereby granted, free of charge/);
});
