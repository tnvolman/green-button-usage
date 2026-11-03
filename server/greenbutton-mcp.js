#!/usr/bin/env node
"use strict";

/**
 * Green Button usage MCP server.
 *
 * Zero dependencies. JSON-RPC over stdio. One JSON object per line, or a
 * Content-Length framed message. This process never opens a socket.
 * Loaded files stay in memory and disappear when the process exits.
 */

const { dispatchTool, maskErrorText } = require("./tools");

const SERVER_NAME = "green-button";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL = "2024-11-05";
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const TOOLS = [
  {
    name: "load_greenbutton",
    description:
      "Load a local Green Button file. Pass a path, ESPI XML text, or usage CSV text. " +
      "Nothing is downloaded and nothing is sent over the network. " +
      "Returns a file id, meters, date range, and units. Customer, address, and account fields are omitted. " +
      "A meter ID or usage-point ID with 6 or more digits is returned as **** plus its last 4 characters.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to a local .xml or .csv Green Button download." },
        xml_text: { type: "string", description: "ESPI Atom XML. Use a path for large files." },
        csv_text: { type: "string", description: "Utility usage CSV in the documented column layout." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_usage_points",
    description: "List usage points and meters for a loaded file. Pass fileId when more than one file is loaded.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "usage_summary",
    description:
      "Day, week, or month totals for one meter. avg, min, and max describe the bucket totals. " +
      "Delivered and received (solar export) stay separate unless direction is net or all.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        meterId: { type: "string" },
        usagePointId: { type: "string" },
        granularity: { type: "string", enum: ["day", "week", "month"] },
        direction: { type: "string", enum: ["delivered", "received", "net", "all"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "peak_hours",
    description:
      "Top intervals, average by local hour, weekday versus weekend, baseload, and load factor. " +
      "Does not mix delivered with received.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        meterId: { type: "string" },
        usagePointId: { type: "string" },
        direction: { type: "string", enum: ["delivered", "received"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "compare_periods",
    description:
      "Compare month-over-month, year-over-year, or two explicit ranges. " +
      "perDay divides by the number of local calendar days in the window. " +
      "Date-only bounds are inclusive local dates.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        meterId: { type: "string" },
        usagePointId: { type: "string" },
        mode: { type: "string", enum: ["mom", "yoy", "ranges"] },
        direction: { type: "string", enum: ["delivered", "received", "net", "all"] },
        periodA: {
          type: "object",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
          additionalProperties: false,
        },
        periodB: {
          type: "object",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "estimate_cost",
    description:
      "Estimate cost from the file's own interval costs when they exist, or from a flat, time-of-use, or tier rate, plus an optional fixed monthly charge. Always an estimate, never a bill.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        meterId: { type: "string" },
        usagePointId: { type: "string" },
        direction: { type: "string", enum: ["delivered", "received"] },
        useFileCost: { type: "boolean", description: "Default true. Set false to ignore costs stored in the file." },
        fixedMonthly: { type: "number", description: "Fixed charge added once per calendar month that has readings." },
        rate: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["flat", "tou", "tiers"] },
            pricePerUnit: { type: "number" },
            offPeakPrice: { type: "number" },
            currency: { type: "string" },
            windows: { type: "array" },
            tiers: { type: "array" },
          },
          required: ["type"],
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "export_normalized",
    description:
      "Write the normalized meters, readings, and bill periods as CSV or JSON to a path you choose. This is the only disk write. Refuses to replace an existing file unless overwrite is true.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        path: { type: "string" },
        format: { type: "string", enum: ["csv", "json"] },
        overwrite: {
          type: "boolean",
          description: "Set true to replace a file that already exists at path. Omitted or false leaves that file untouched.",
        },
      },
      required: ["path", "format"],
      additionalProperties: false,
    },
  },
];

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function toolOk(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function writeMessage(payload, framing) {
  const json = JSON.stringify(payload);
  if (framing === "content-length") {
    const body = Buffer.from(json, "utf8");
    process.stdout.write("Content-Length: " + body.length + "\r\n\r\n");
    process.stdout.write(body);
    return;
  }
  process.stdout.write(json + "\n");
}

function rpcResult(id, result, framing) {
  writeMessage({ jsonrpc: "2.0", id, result }, framing);
}

function rpcError(id, code, message, framing) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } }, framing);
}

function callTool(params) {
  const name = params && params.name;
  let args = params ? params.arguments : {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (_err) {
      return toolError("Tool arguments were not JSON.");
    }
  }
  if (args == null) args = {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return toolError("Tool arguments must be an object.");
  try {
    return toolOk(dispatchTool(name, args));
  } catch (err) {
    const message = err && err.message ? err.message : "The tool failed.";
    return toolError(maskErrorText(message));
  }
}

function handle(message, framing) {
  const frame = framing === "content-length" ? "content-length" : "ndjson";
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    rpcError(null, -32600, "Invalid Request", frame);
    return;
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : undefined;
  if (typeof message.method !== "string") {
    if (hasId) rpcError(id, -32600, "Invalid Request", frame);
    return;
  }
  if (message.method.indexOf("notifications/") === 0 || !hasId) return;

  if (message.method === "initialize") {
    const requested = message.params && message.params.protocolVersion;
    rpcResult(
      id,
      {
        protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "The user downloads a Green Button file from their utility. " +
          "Call load_greenbutton with the local path. Do not log in, do not fetch the file, and do not send it anywhere. " +
          "Keep delivered usage and received solar export separate. " +
          "A meter ID or usage-point ID with 6 or more digits is masked to **** and its last 4 characters. Do not reconstruct the full ID. " +
          "Cost figures are estimates. If a tool returns an error, show that error only.",
      },
      frame
    );
    return;
  }
  if (message.method === "ping") {
    rpcResult(id, {}, frame);
    return;
  }
  if (message.method === "tools/list") {
    rpcResult(id, { tools: TOOLS }, frame);
    return;
  }
  if (message.method === "tools/call") {
    rpcResult(id, callTool(message.params || {}), frame);
    return;
  }
  rpcError(id, -32601, "Method not found", frame);
}

let buffer = Buffer.alloc(0);

function dispatch(text, framing) {
  try {
    handle(JSON.parse(text), framing);
  } catch (_err) {
    rpcError(null, -32700, "Parse error", framing);
  }
}

function consume() {
  while (buffer.length) {
    if (buffer[0] === 0x0a || buffer[0] === 0x0d) {
      buffer = buffer.subarray(1);
      continue;
    }
    if (buffer[0] === 0x7b) {
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) return;
      let line = buffer.subarray(0, nl);
      buffer = buffer.subarray(nl + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      dispatch(line.toString("utf8"), "ndjson");
      continue;
    }
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep === -1) {
      let bare = -1;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0x0a && (i === 0 || buffer[i - 1] !== 0x0d)) {
          bare = i;
          break;
        }
      }
      if (bare === -1) return;
      buffer = buffer.subarray(bare + 1);
      rpcError(null, -32700, "Parse error", "ndjson");
      continue;
    }
    const header = buffer.subarray(0, sep).toString("utf8");
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) {
      process.stderr.write("greenbutton-mcp: missing Content-Length\n");
      process.exit(1);
    }
    const length = Number(match[1]);
    if (!Number.isInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
      process.stderr.write("greenbutton-mcp: invalid Content-Length\n");
      process.exit(1);
    }
    const start = sep + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    dispatch(body, "content-length");
  }
}

function start() {
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE_BYTES) {
      process.stderr.write("greenbutton-mcp: message too large\n");
      process.exit(1);
    }
    consume();
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
}

if (require.main === module) start();

module.exports = { SERVER_NAME, SERVER_VERSION, TOOLS, callTool };
