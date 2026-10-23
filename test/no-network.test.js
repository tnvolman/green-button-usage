"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns");
const { clearStore, loadGreenbutton, usageSummary } = require("../server/tools");

const serverDir = path.join(__dirname, "..", "server");

test("server source does not call the network", () => {
  const files = fs.readdirSync(serverDir).filter((name) => name.endsWith(".js"));
  assert.ok(files.length >= 4);
  const patterns = [
    /require\(\s*["'](?:node:)?(?:https?|net|dns|tls|http2|dgram)["']\s*\)/,
    /from\s*["'](?:node:)?(?:https?|net|dns|tls|http2|dgram)["']/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bundici\b/,
    /\baxios\b/,
    /\bhttp\.request\s*\(/,
    /\bhttps\.request\s*\(/,
    /\bnet\.connect\s*\(/,
    /\bdns\.lookup\s*\(/,
  ];
  for (const name of files) {
    const source = fs.readFileSync(path.join(serverDir, name), "utf8");
    for (const pattern of patterns) {
      assert.equal(pattern.test(source), false, name + " matched " + pattern);
    }
  }
});

test("parsing a file full of https hrefs does not touch the network", () => {
  const calls = [];
  function bomb(label) {
    return () => {
      calls.push(label);
      throw new Error("network call: " + label);
    };
  }
  const originals = {
    request: http.request,
    get: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    connect: net.connect,
    createConnection: net.createConnection,
    lookup: dns.lookup,
    resolve: dns.resolve,
    fetch: global.fetch,
  };
  http.request = bomb("http.request");
  http.get = bomb("http.get");
  https.request = bomb("https.request");
  https.get = bomb("https.get");
  net.connect = bomb("net.connect");
  net.createConnection = bomb("net.createConnection");
  dns.lookup = bomb("dns.lookup");
  dns.resolve = bomb("dns.resolve");
  global.fetch = bomb("fetch");
  try {
    clearStore();
    const xml = fs.readFileSync(path.join(__dirname, "..", "samples", "electric-hourly.xml"), "utf8");
    assert.match(xml, /https:\/\/synthetic\.example/);
    const loaded = loadGreenbutton({ xml_text: xml });
    const summary = usageSummary({ fileId: loaded.fileId, meterId: "DELIVERED", granularity: "month" });
    assert.ok(summary.overall.total > 0);
    assert.deepEqual(calls, []);
  } finally {
    http.request = originals.request;
    http.get = originals.get;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    net.connect = originals.connect;
    net.createConnection = originals.createConnection;
    dns.lookup = originals.lookup;
    dns.resolve = originals.resolve;
    global.fetch = originals.fetch;
    clearStore();
  }
});
