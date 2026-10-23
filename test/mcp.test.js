"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const serverPath = path.join(__dirname, "..", "server", "greenbutton-mcp.js");
const preloadPath = path.join(__dirname, "no-net-preload.js");
const transcriptPath = "/tmp/gb-stdio-transcript.txt";

function frame(message, framing) {
  const json = JSON.stringify(message);
  if (framing === "content-length") {
    const body = Buffer.from(json, "utf8");
    return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "utf8"), body]);
  }
  return Buffer.from(json + "\n", "utf8");
}

function startClient() {
  const child = spawn(process.execPath, ["-r", preloadPath, serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = Buffer.alloc(0);
  let stderr = "";
  const waiters = [];
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  function take() {
    let i = 0;
    while (i < buf.length && (buf[i] === 10 || buf[i] === 13)) i += 1;
    if (i) buf = buf.subarray(i);
    if (!buf.length) return null;
    if (buf[0] === 0x7b) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return null;
      const message = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      buf = buf.subarray(nl + 1);
      return message;
    }
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) return null;
    const header = buf.subarray(0, sep).toString("utf8");
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) throw new Error("missing Content-Length in " + header);
    const length = Number(match[1]);
    const start = sep + 4;
    if (buf.length < start + length) return null;
    const message = JSON.parse(buf.subarray(start, start + length).toString("utf8"));
    buf = buf.subarray(start + length);
    return message;
  }
  function pump() {
    while (waiters.length) {
      const message = take();
      if (!message) return;
      waiters.shift().resolve(message);
    }
  }
  function nextMessage() {
    const already = take();
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for MCP response\n" + stderr));
      }, 5000);
      waiters.push({
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject,
      });
      pump();
    });
  }
  return { child, stderr: () => stderr, nextMessage };
}

test("MCP stdio round trip: initialize, tools/list, tools/call", async () => {
  const client = startClient();
  const transcript = [];
  function send(message, framing) {
    transcript.push({ direction: "client", framing, message });
    client.child.stdin.write(frame(message, framing));
  }
  async function receive() {
    const message = await client.nextMessage();
    transcript.push({ direction: "server", message });
    return message;
  }
  try {
    send(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "green-button-test", version: "0.0.1" },
        },
      },
      "content-length"
    );
    const init = await receive();
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.name, "green-button");
    assert.equal(init.result.serverInfo.version, "0.1.0");
    assert.equal(init.result.capabilities.tools.listChanged, false);

    send({ jsonrpc: "2.0", method: "notifications/initialized" }, "ndjson");

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "content-length");
    const listed = await receive();
    assert.equal(listed.id, 2);
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "load_greenbutton",
      "list_usage_points",
      "usage_summary",
      "peak_hours",
      "compare_periods",
      "estimate_cost",
      "export_normalized",
    ]);

    const xml =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">' +
      "<entry><id>urn:synthetic:UsagePoint/UP</id><content><espi:UsagePoint><espi:ServiceCategory><espi:kind>0</espi:kind></espi:ServiceCategory></espi:UsagePoint></content></entry>" +
      "<entry><content><espi:LocalTimeParameters><espi:dstEndRule>FFFFFFFF</espi:dstEndRule><espi:dstOffset>0</espi:dstOffset><espi:dstStartRule>FFFFFFFF</espi:dstStartRule><espi:tzOffset>0</espi:tzOffset></espi:LocalTimeParameters></content></entry>" +
      "<entry><id>urn:synthetic:MeterReading/M</id><content><espi:MeterReading></espi:MeterReading></content></entry>" +
      "<entry><content><espi:ReadingType><espi:currency>840</espi:currency><espi:flowDirection>1</espi:flowDirection><espi:intervalLength>3600</espi:intervalLength><espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:uom>72</espi:uom></espi:ReadingType></content></entry>" +
      "<entry><content><espi:IntervalBlock><espi:IntervalReading><espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1700000000</espi:start></espi:timePeriod><espi:value>2000</espi:value><espi:cost>100000</espi:cost></espi:IntervalReading></espi:IntervalBlock></content></entry>" +
      "</feed>";
    send(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "load_greenbutton", arguments: { xml_text: xml } },
      },
      "ndjson"
    );
    const loaded = await receive();
    assert.equal(loaded.id, 3);
    assert.equal(loaded.result.isError, false);
    const summary = JSON.parse(loaded.result.content[0].text);
    assert.equal(summary.readingCount, 1);
    assert.equal(summary.meters[0].unit, "kWh");

    send(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "usage_summary", arguments: { fileId: summary.fileId, granularity: "day" } },
      },
      "content-length"
    );
    const usage = await receive();
    assert.equal(usage.id, 4);
    const usageBody = JSON.parse(usage.result.content[0].text);
    assert.equal(usageBody.overall.total, 2);
    assert.equal(usage.result.isError, false);
    assert.equal(client.stderr(), "");
  } finally {
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
    client.child.kill();
  }
});
