#!/usr/bin/env node
"use strict";

/**
 * Write the synthetic samples. No customer data: names, streets, and
 * account numbers below are fake and exist so the parser can prove it
 * drops them.
 */

const fs = require("fs");
const path = require("path");
const { decodeDstRule, localParts, localDateString, localWallToUtc } = require("../server/units");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "samples");

const pacific = {
  tzOffset: -28800,
  dstOffset: 3600,
  dstStartRule: "360E2000",
  dstEndRule: "B40E2000",
  dstStart: decodeDstRule("360E2000"),
  dstEnd: decodeDstRule("B40E2000"),
};

function assertSampleClock() {
  const spring = localParts(Date.parse("2024-03-10T10:00:00Z"), pacific);
  const before = localParts(Date.parse("2024-03-10T09:00:00Z"), pacific);
  const fallA = localParts(Date.parse("2024-11-03T08:00:00Z"), pacific);
  const fallB = localParts(Date.parse("2024-11-03T09:00:00Z"), pacific);
  if (before.hour !== 1 || spring.hour !== 3 || fallA.hour !== 1 || fallB.hour !== 1) {
    throw new Error("DST spot check failed before writing samples.");
  }
}

function deliveredWh(parts) {
  let wh = 250;
  if (parts.hour >= 6 && parts.hour <= 8) wh += 350;
  if (parts.hour >= 17 && parts.hour <= 20) wh += parts.month >= 6 && parts.month <= 9 ? 1300 : 650;
  if (parts.month >= 6 && parts.month <= 9 && parts.hour >= 12 && parts.hour <= 18) wh += 200;
  wh += (parts.day * 13 + parts.hour) % 40;
  return wh;
}

function exportWh(parts) {
  if (parts.hour < 8 || parts.hour > 17) return 0;
  const summer = parts.month >= 5 && parts.month <= 9 ? 1.5 : 0.6;
  const bell = { 8: 150, 9: 400, 10: 700, 11: 950, 12: 1100, 13: 1100, 14: 900, 15: 650, 16: 350, 17: 120 };
  return Math.round(bell[parts.hour] * summer);
}

function readingXml(start, value, cost) {
  const costXml = cost == null ? "" : "<espi:cost>" + cost + "</espi:cost>";
  return (
    "<espi:IntervalReading>" +
    costXml +
    "<espi:timePeriod><espi:duration>3600</espi:duration><espi:start>" +
    start +
    "</espi:start></espi:timePeriod><espi:value>" +
    value +
    "</espi:value></espi:IntervalReading>"
  );
}

function blockEntry(channel, day, readings) {
  const id = channel + "-" + day.replace(/-/g, "");
  return (
    "<entry><id>urn:synthetic:IntervalBlock/" +
    id +
    "</id>" +
    '<link rel="self" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading/' +
    channel +
    "/IntervalBlock/" +
    id +
    '"/>' +
    '<link rel="up" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading/' +
    channel +
    '"/>' +
    "<content><espi:IntervalBlock><espi:interval><espi:duration>" +
    readings.length * 3600 +
    "</espi:duration><espi:start>" +
    readings[0].start +
    "</espi:start></espi:interval>" +
    readings.map((item) => readingXml(item.start, item.wh, item.cost)).join("") +
    "</espi:IntervalBlock></content></entry>"
  );
}

function groupByDay(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.localDate)) map.set(row.localDate, []);
    map.get(row.localDate).push(row);
  }
  return map;
}

function buildElectric() {
  const startMs = localWallToUtc(2024, 1, 1, 0, 0, 0, pacific);
  const endMs = localWallToUtc(2025, 2, 1, 0, 0, 0, pacific);
  const delivered = [];
  const received = [];
  for (let utc = startMs; utc < endMs; utc += 3600000) {
    const parts = localParts(utc, pacific);
    const wh = deliveredWh(parts);
    delivered.push({
      start: utc / 1000,
      wh,
      cost: Math.round((wh / 1000) * 0.3 * 100000),
      localDate: localDateString(parts),
      month: parts.month,
      year: parts.year,
    });
    const exp = exportWh(parts);
    if (exp > 0) {
      received.push({
        start: utc / 1000,
        wh: exp,
        cost: -Math.round((exp / 1000) * 0.08 * 100000),
        localDate: localDateString(parts),
      });
    }
  }

  const months = new Map();
  for (const row of delivered) {
    const key = row.year + "-" + String(row.month).padStart(2, "0");
    if (!months.has(key)) months.set(key, { wh: 0, cost: 0, start: row.start, end: row.start + 3600 });
    const bucket = months.get(key);
    bucket.wh += row.wh;
    bucket.cost += row.cost;
    if (row.start < bucket.start) bucket.start = row.start;
    if (row.start + 3600 > bucket.end) bucket.end = row.start + 3600;
  }

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">');
  parts.push("<id>urn:synthetic:feed:electric</id><title>Synthetic electric hourly usage</title><updated>2025-02-01T00:00:00Z</updated>");
  parts.push(
    "<entry><id>urn:synthetic:customer</id><title>Dropped</title><content>" +
      "<espi:CustomerAccount><espi:name>Synthetic Person</espi:name><espi:accountId>ACCT-998877</espi:accountId></espi:CustomerAccount>" +
      "<espi:ServiceLocation><espi:mainAddress><espi:streetDetail>123 Secret Street</espi:streetDetail>" +
      "<espi:townDetail>Exampletown</espi:townDetail></espi:mainAddress></espi:ServiceLocation>" +
      "</content></entry>"
  );
  parts.push(
    "<entry><id>urn:synthetic:UsagePoint/ELECTRIC-1</id>" +
      '<link rel="self" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1"/>' +
      '<link rel="related" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading"/>' +
      '<link rel="related" href="https://synthetic.example/espi/LocalTimeParameters/LTP-PACIFIC"/>' +
      '<link rel="related" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/UsageSummary"/>' +
      "<content><espi:UsagePoint><espi:ServiceCategory><espi:kind>0</espi:kind></espi:ServiceCategory></espi:UsagePoint></content></entry>"
  );
  parts.push(
    "<entry><id>urn:synthetic:LocalTimeParameters/LTP-PACIFIC</id>" +
      '<link rel="self" href="https://synthetic.example/espi/LocalTimeParameters/LTP-PACIFIC"/>' +
      "<content><espi:LocalTimeParameters>" +
      "<espi:dstEndRule>B40E2000</espi:dstEndRule><espi:dstOffset>3600</espi:dstOffset>" +
      "<espi:dstStartRule>360E2000</espi:dstStartRule><espi:tzOffset>-28800</espi:tzOffset>" +
      "</espi:LocalTimeParameters></content></entry>"
  );
  for (const channel of ["DELIVERED", "RECEIVED"]) {
    const flow = channel === "DELIVERED" ? 1 : 19;
    parts.push(
      "<entry><id>urn:synthetic:MeterReading/" +
        channel +
        "</id>" +
        '<link rel="self" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading/' +
        channel +
        '"/>' +
        '<link rel="up" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1"/>' +
        '<link rel="related" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading/' +
        channel +
        '/IntervalBlock"/>' +
        '<link rel="related" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading/' +
        channel +
        "/ReadingType/RT-" +
        channel +
        '"/>' +
        "<content><espi:MeterReading></espi:MeterReading></content></entry>"
    );
    parts.push(
      "<entry><id>urn:synthetic:ReadingType/RT-" +
        channel +
        "</id>" +
        '<link rel="self" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading/' +
        channel +
        "/ReadingType/RT-" +
        channel +
        '"/>' +
        '<link rel="up" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/MeterReading/' +
        channel +
        '"/>' +
        "<content><espi:ReadingType><espi:accumulationBehaviour>4</espi:accumulationBehaviour>" +
        "<espi:currency>840</espi:currency><espi:flowDirection>" +
        flow +
        "</espi:flowDirection><espi:intervalLength>3600</espi:intervalLength>" +
        "<espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:uom>72</espi:uom></espi:ReadingType></content></entry>"
    );
  }
  for (const [day, rows] of groupByDay(delivered)) parts.push(blockEntry("DELIVERED", day, rows));
  for (const [day, rows] of groupByDay(received)) parts.push(blockEntry("RECEIVED", day, rows));
  for (const [key, bucket] of months) {
    const duration = bucket.end - bucket.start;
    parts.push(
      "<entry><id>urn:synthetic:UsageSummary/" +
        key +
        "</id>" +
        '<link rel="self" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1/UsageSummary/' +
        key +
        '"/>' +
        '<link rel="up" href="https://synthetic.example/espi/UsagePoint/ELECTRIC-1"/>' +
        "<content><espi:UsageSummary><espi:billingPeriod><espi:duration>" +
        duration +
        "</espi:duration><espi:start>" +
        bucket.start +
        "</espi:start></espi:billingPeriod><espi:billLastPeriod>" +
        bucket.cost +
        "</espi:billLastPeriod><espi:currency>840</espi:currency>" +
        "<espi:overallConsumptionLastPeriod><espi:powerOfTenMultiplier>0</espi:powerOfTenMultiplier><espi:uom>72</espi:uom><espi:value>" +
        bucket.wh +
        "</espi:value></espi:overallConsumptionLastPeriod></espi:UsageSummary></content></entry>"
    );
  }
  parts.push("</feed>");
  return { xml: parts.join(""), delivered: delivered.length, received: received.length };
}

function buildGas() {
  const tz = {
    tzOffset: -28800,
    dstOffset: 0,
    dstStart: { disabled: true },
    dstEnd: { disabled: true },
  };
  const rows = [];
  for (let month = 1; month <= 12; month++) {
    const days = new Date(Date.UTC(2024, month, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      const base = [4.2, 3.8, 3.1, 2.0, 1.1, 0.6, 0.4, 0.4, 0.7, 1.5, 2.8, 3.9][month - 1];
      const therms = Math.round((base + (day % 5) * 0.1) * 10) / 10;
      const start = localWallToUtc(2024, month, day, 0, 0, 0, tz);
      rows.push({ start: start / 1000, value: Math.round(therms * 10), cost: Math.round(therms * 1.8 * 100000) });
    }
  }
  const chunks = [];
  chunks.push('<?xml version="1.0" encoding="UTF-8"?>');
  chunks.push('<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">');
  chunks.push("<title>Synthetic gas daily usage</title>");
  chunks.push(
    "<entry><content><espi:CustomerAccount><espi:name>Synthetic Person</espi:name><espi:accountId>ACCT-998877</espi:accountId></espi:CustomerAccount></content></entry>"
  );
  chunks.push("<entry><content><espi:UsagePoint><espi:ServiceCategory><espi:kind>1</espi:kind></espi:ServiceCategory></espi:UsagePoint></content></entry>");
  chunks.push(
    "<entry><content><espi:LocalTimeParameters><espi:dstEndRule>FFFFFFFF</espi:dstEndRule><espi:dstOffset>0</espi:dstOffset>" +
      "<espi:dstStartRule>FFFFFFFF</espi:dstStartRule><espi:tzOffset>-28800</espi:tzOffset></espi:LocalTimeParameters></content></entry>"
  );
  chunks.push("<entry><content><espi:MeterReading></espi:MeterReading></content></entry>");
  chunks.push(
    "<entry><content><espi:ReadingType><espi:currency>840</espi:currency><espi:flowDirection>1</espi:flowDirection>" +
      "<espi:intervalLength>86400</espi:intervalLength><espi:powerOfTenMultiplier>-1</espi:powerOfTenMultiplier><espi:uom>169</espi:uom></espi:ReadingType></content></entry>"
  );
  const readingXml = rows
    .map(
      (row) =>
        "<espi:IntervalReading><espi:cost>" +
        row.cost +
        "</espi:cost><espi:timePeriod><espi:duration>86400</espi:duration><espi:start>" +
        row.start +
        "</espi:start></espi:timePeriod><espi:value>" +
        row.value +
        "</espi:value></espi:IntervalReading>"
    )
    .join("");
  chunks.push(
    "<entry><content><espi:IntervalBlock><espi:interval><espi:duration>" +
      rows.length * 86400 +
      "</espi:duration><espi:start>" +
      rows[0].start +
      "</espi:start></espi:interval>" +
      readingXml +
      "</espi:IntervalBlock></content></entry>"
  );
  const first = rows[0];
  const last = rows[rows.length - 1];
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  chunks.push(
    "<entry><content><espi:UsageSummary><espi:billingPeriod><espi:duration>" +
      (last.start + 86400 - first.start) +
      "</espi:duration><espi:start>" +
      first.start +
      "</espi:start></espi:billingPeriod><espi:billLastPeriod>" +
      totalCost +
      "</espi:billLastPeriod><espi:currency>840</espi:currency>" +
      "<espi:overallConsumptionLastPeriod><espi:powerOfTenMultiplier>-1</espi:powerOfTenMultiplier><espi:uom>169</espi:uom><espi:value>" +
      totalValue +
      "</espi:value></espi:overallConsumptionLastPeriod></espi:UsageSummary></content></entry>"
  );
  chunks.push("</feed>");
  return { xml: chunks.join(""), readings: rows.length };
}

function buildCsv() {
  const lines = [
    "Name,Synthetic Person",
    "Address,123 Secret Street",
    "Account Number,ACCT-998877",
    "",
    "Meter,Type,Date,Start Time,End Time,Usage,Units,Cost,Direction,utc_offset",
  ];
  for (let day = 1; day <= 7; day++) {
    const date = "2024-07-" + String(day).padStart(2, "0");
    for (let hour = 0; hour < 24; hour++) {
      const usage = (0.4 + (hour >= 17 && hour <= 20 ? 1.2 : 0) + (hour % 3) * 0.05).toFixed(2);
      const endHour = (hour + 1) % 24;
      const endDate = endHour === 0 ? "2024-07-" + String(day + 1).padStart(2, "0") : date;
      const cost = (Number(usage) * 0.32).toFixed(2);
      lines.push(
        ["MTR-E1", "Electric", date, pad(hour) + ":00", pad(endHour) + ":00", usage, "kWh", cost, "delivered", "-28800"].join(",")
      );
      if (hour >= 10 && hour <= 15) {
        lines.push(
          ["MTR-E1", "Electric", date, pad(hour) + ":00", pad(endHour) + ":00", "0.80", "kWh", "-0.06", "received", "-28800"].join(",")
        );
      }
    }
  }
  // A quoted note proves the reader keeps commas inside quotes.
  lines.push('MTR-E1,Electric,2024-07-08,12:00,13:00,1.25,kWh,0.40,delivered,-28800');
  return lines.join("\n") + "\n";
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function main() {
  assertSampleClock();
  fs.mkdirSync(outDir, { recursive: true });
  const electric = buildElectric();
  const gas = buildGas();
  const csv = buildCsv();
  fs.writeFileSync(path.join(outDir, "electric-hourly.xml"), electric.xml);
  fs.writeFileSync(path.join(outDir, "gas-daily.xml"), gas.xml);
  fs.writeFileSync(path.join(outDir, "usage-export.csv"), csv);
  process.stdout.write(
    "samples written: electric delivered=" +
      electric.delivered +
      " received=" +
      electric.received +
      " gas=" +
      gas.readings +
      "\n"
  );
}

if (require.main === module) main();

module.exports = { buildElectric, buildGas, buildCsv };
