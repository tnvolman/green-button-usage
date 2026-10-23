"use strict";

const Module = require("module");
const original = Module.prototype.require;
const blocked = new Set(["http", "https", "net", "dns", "tls", "http2", "dgram"]);

Module.prototype.require = function (id) {
  const name = String(id).startsWith("node:") ? String(id).slice(5) : String(id);
  if (blocked.has(name)) {
    throw new Error("network module loaded: " + id);
  }
  return original.apply(this, arguments);
};
