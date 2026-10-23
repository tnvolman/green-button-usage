"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parseEspi, parseCsv } = require("../server/parse");
const { feed, localTime, readingType, intervalBlock, usagePoint, meter, unix } = require("./helpers");

const samples = path.join(__dirname, "..", "samples");

function noPii(value) {
  const blob = JSON.stringify(value);
  assert.equal(blob.includes("123 Secret Street"), false);
  assert.equal(blob.includes("ACCT-998877"), false);
  assert.equal(blob.includes("Synthetic Person"), false);
  assert.equal(blob.includes("Exampletown"), false);
}

test("electric sample keeps delivered and received apart across DST", () => {
  const parsed = parseEspi(fs.readFileSync(path.join(samples, "electric-hourly.xml"), "utf8"));
  noPii(parsed);
  assert.equal(parsed.format, "espi");
  assert.equal(parsed.strippedCustomerFields, true);
  assert.equal(parsed.meters.length, 2);
  const delivered = parsed.meters.find((item) => item.id === "DELIVERED");
  const received = parsed.meters.find((item) => item.id === "RECEIVED");
  assert.equal(delivered.kind, "electric");
  assert.equal(delivered.unit, "kWh");
  assert.equal(delivered.intervalSec, 3600);
  assert.equal(delivered.direction, "delivered");
  assert.equal(delivered.tz.tzOffset, -28800);
  assert.equal(delivered.tz.dstStartRule, "360E2000");
  assert.equal(received.direction, "received");
  assert.ok(!parsed.warnings.some((warning) => warning.code === "unlinked-entries"));

  const deliveredRows = parsed.readings.filter((reading) => reading.meterId === "DELIVERED");
  const receivedRows = parsed.readings.filter((reading) => reading.meterId === "RECEIVED");
  assert.equal(deliveredRows.length, 9528);
  assert.ok(receivedRows.length > 0);
  assert.equal(parsed.dateRange.startUtc, "2024-01-01T08:00:00Z");
  assert.equal(parsed.dateRange.endUtc, "2025-02-01T08:00:00Z");

  const march10 = deliveredRows.filter((reading) => reading.localDate === "2024-03-10");
  assert.equal(march10.length, 23);
  assert.equal(march10.some((reading) => reading.localHour === 2), false);
  const november3 = deliveredRows.filter((reading) => reading.localDate === "2024-11-03");
  assert.equal(november3.length, 25);
  assert.equal(november3.filter((reading) => reading.localHour === 1).length, 2);

  const winterNoon = receivedRows.find((reading) => reading.localDate === "2024-01-15" && reading.localHour === 12);
  const summerNoon = receivedRows.find((reading) => reading.localDate === "2024-07-15" && reading.localHour === 12);
  assert.ok(winterNoon.value > 0);
  assert.ok(summerNoon.value > winterNoon.value);
  assert.equal(receivedRows.some((reading) => reading.localDate === "2024-01-15" && reading.localHour === 3), false);

  const january = deliveredRows.filter((reading) => reading.localDate.startsWith("2024-01"));
  const bill = parsed.billPeriods.find((period) => period.startUtc === january[0].startUtc);
  assert.ok(bill);
  const consumption = january.reduce((total, reading) => total + reading.value, 0);
  assert.ok(Math.abs(bill.consumption - consumption) < 0.001);
  const cost = january.reduce((total, reading) => total + reading.cost, 0);
  assert.ok(Math.abs(bill.cost - cost) < 0.02);
  assert.equal(bill.currency, "USD");
  assert.equal(parsed.billPeriods.length, 13);
});

test("gas sample resolves a feed that has no links", () => {
  const parsed = parseEspi(fs.readFileSync(path.join(samples, "gas-daily.xml"), "utf8"));
  noPii(parsed);
  assert.equal(parsed.meters.length, 1);
  assert.equal(parsed.meters[0].kind, "gas");
  assert.equal(parsed.meters[0].unit, "therm");
  assert.equal(parsed.meters[0].intervalSec, 86400);
  assert.equal(parsed.meters[0].tz.tzOffset, -28800);
  assert.equal(parsed.readings.length, 366);
  assert.ok(parsed.readings.every((reading) => reading.localHour === 0));
  assert.equal(parsed.readings[0].value, 4.3);
  assert.equal(parsed.readings[0].direction, "delivered");
  assert.ok(parsed.warnings.some((warning) => warning.code === "unlinked-entries"));
  assert.equal(parsed.billPeriods.length, 1);
  assert.equal(parsed.billPeriods[0].unit, "therm");
});

test("CSV sample uses the documented columns and drops the preamble", () => {
  const parsed = parseCsv(fs.readFileSync(path.join(samples, "usage-export.csv"), "utf8"));
  noPii(parsed);
  assert.equal(parsed.format, "csv");
  assert.equal(parsed.meters.length, 1);
  assert.equal(parsed.meters[0].id, "MTR-E1");
  assert.equal(parsed.meters[0].unit, "kWh");
  assert.equal(parsed.meters[0].kind, "electric");
  const first = parsed.readings.find((reading) => reading.direction === "delivered" && reading.localDate === "2024-07-01" && reading.localHour === 0);
  assert.equal(first.startUtc, "2024-07-01T08:00:00Z");
  assert.equal(first.value, 0.4);
  assert.equal(first.cost, 0.13);
  const exported = parsed.readings.find((reading) => reading.direction === "received" && reading.localHour === 10);
  assert.equal(exported.value, 0.8);
  assert.ok(parsed.warnings.some((warning) => warning.code === "stripped-customer-fields"));
  assert.equal(parsed.warnings.some((warning) => warning.code === "csv-naive-time"), false);
});

test("multiplier, missing links, namespaces, and a single resource", () => {
  const linked = parseEspi(
    feed(
      usagePoint(0) +
        localTime(0) +
        meter("M1") +
        readingType("RT", 1, 72, 3, 3600, 840) +
        intervalBlock([{ start: unix("2024-06-01T00:00:00Z"), duration: 3600, value: 1500, cost: 250000 }])
    )
  );
  assert.equal(linked.readings[0].value, 1500);
  assert.equal(linked.readings[0].cost, 2.5);
  assert.equal(linked.meters[0].id, "M1");

  const bare = parseEspi(
    '<UsagePoint xmlns="http://naesb.org/espi"><ServiceCategory><kind>2</kind></ServiceCategory>' +
      "<MeterReading><ReadingType><uom>128</uom><powerOfTenMultiplier>0</powerOfTenMultiplier>" +
      "<intervalLength>86400</intervalLength><flowDirection>1</flowDirection><currency>840</currency></ReadingType>" +
      "<IntervalBlock><IntervalReading><timePeriod><duration>86400</duration><start>" +
      unix("2024-05-01T00:00:00Z") +
      "</start></timePeriod><value>80</value></IntervalReading></IntervalBlock></MeterReading></UsagePoint>"
  );
  assert.equal(bare.meters[0].kind, "water");
  assert.equal(bare.meters[0].unit, "gal");
  assert.equal(bare.readings[0].value, 80);
  assert.equal(bare.readings[0].direction, "delivered");

  const receivedOnly = parseEspi(
    feed(
      usagePoint(0) +
        localTime(0) +
        meter("OUT") +
        readingType("RT", 19, 72, 0, 3600, 840) +
        intervalBlock([{ start: unix("2024-06-01T18:00:00Z"), duration: 3600, value: 500, cost: -4000 }])
    )
  );
  assert.equal(receivedOnly.readings[0].direction, "received");
  assert.equal(receivedOnly.readings[0].value, 0.5);
  assert.equal(receivedOnly.readings[0].cost, -0.04);
});

test("CSV quotes, naive clocks, and a header buried under a preamble", () => {
  const parsed = parseCsv(
    'Account,ACCT-1\n"Service address","12 Example Lane, Apt 2"\n\n' +
      "DATE,START TIME,END TIME,Usage (kWh),COST\n" +
      '01/02/2024,1:00 PM,2:00 PM,"1,250.5","$2.50"\n'
  );
  assert.equal(parsed.readings.length, 1);
  assert.equal(parsed.readings[0].value, 1250.5);
  assert.equal(parsed.readings[0].cost, 2.5);
  assert.equal(parsed.readings[0].localHour, 13);
  assert.equal(parsed.readings[0].startUtc, "2024-01-02T13:00:00Z");
  assert.ok(parsed.warnings.some((warning) => warning.code === "csv-naive-time"));
  assert.equal(JSON.stringify(parsed).includes("ACCT-1"), false);
  assert.equal(JSON.stringify(parsed).includes("Example Lane"), false);
});
