"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeQuantity,
  costToCurrency,
  flowDirectionName,
  serviceKindName,
  currencyName,
  decodeDstRule,
  dstBoundsUtc,
  offsetAt,
  localParts,
  localDateString,
} = require("../server/units");

const pacific = {
  tzOffset: -28800,
  dstOffset: 3600,
  dstStartRule: "360E2000",
  dstEndRule: "B40E2000",
  dstStart: decodeDstRule("360E2000"),
  dstEnd: decodeDstRule("B40E2000"),
};

test("unit codes and power-of-ten multipliers", () => {
  assert.deepEqual(normalizeQuantity(72, 0, 1500), { symbol: "Wh", unit: "kWh", value: 1.5, known: true });
  assert.deepEqual(normalizeQuantity(72, 3, 1500), { symbol: "Wh", unit: "kWh", value: 1500, known: true });
  assert.deepEqual(normalizeQuantity(72, -3, 1500000), { symbol: "Wh", unit: "kWh", value: 1.5, known: true });
  assert.deepEqual(normalizeQuantity(169, 0, 4), { symbol: "therm", unit: "therm", value: 4, known: true });
  assert.deepEqual(normalizeQuantity(169, -1, 42), { symbol: "therm", unit: "therm", value: 4.2, known: true });
  assert.deepEqual(normalizeQuantity(169, 3, 2), { symbol: "therm", unit: "therm", value: 2000, known: true });
  assert.deepEqual(normalizeQuantity(128, 0, 250), { symbol: "USGal", unit: "gal", value: 250, known: true });
  assert.equal(normalizeQuantity(119, 2, 12).value, 1200);
  assert.equal(normalizeQuantity(119, 2, 12).unit, "ft3");
  assert.equal(normalizeQuantity(999, 0, 5).known, false);
});

test("cost uses the fixed 10^-5 currency scale", () => {
  assert.equal(costToCurrency(100000), 1);
  assert.equal(costToCurrency(0), 0);
  assert.equal(costToCurrency(1234567), 12.34567);
  assert.equal(costToCurrency(-8000), -0.08);
  assert.equal(costToCurrency(null), null);
});

test("service kind, flow direction, and currency", () => {
  assert.equal(serviceKindName(0), "electric");
  assert.equal(serviceKindName("1"), "gas");
  assert.equal(serviceKindName(2), "water");
  assert.equal(serviceKindName("electricity"), "electric");
  assert.equal(flowDirectionName(1), "delivered");
  assert.equal(flowDirectionName(19), "received");
  assert.equal(flowDirectionName(4), "net");
  assert.equal(flowDirectionName(0), "unknown");
  assert.equal(flowDirectionName("export"), "received");
  assert.equal(currencyName(840), "USD");
  assert.equal(currencyName(124), "CAD");
  assert.equal(currencyName("978"), "EUR");
});

test("DST rule bitmap and Pacific transitions", () => {
  const start = decodeDstRule("360E2000");
  assert.equal(start.month, 3);
  assert.equal(start.operator, 3);
  assert.equal(start.dayOfMonth, 0);
  assert.equal(start.dayOfWeek, 7);
  assert.equal(start.hour, 2);
  assert.equal(start.seconds, 0);
  const end = decodeDstRule("B40E2000");
  assert.equal(end.month, 11);
  assert.equal(end.operator, 2);
  assert.equal(end.dayOfWeek, 7);
  assert.equal(end.hour, 2);
  assert.equal(decodeDstRule("FFFFFFFF").disabled, true);

  const bounds = dstBoundsUtc(pacific, 2024);
  assert.equal(new Date(bounds.startUtc).toISOString(), "2024-03-10T10:00:00.000Z");
  assert.equal(new Date(bounds.endUtc).toISOString(), "2024-11-03T09:00:00.000Z");

  assert.equal(offsetAt(pacific, Date.parse("2024-03-10T09:59:59Z")), -28800);
  assert.equal(offsetAt(pacific, Date.parse("2024-03-10T10:00:00Z")), -25200);
  assert.equal(offsetAt(pacific, Date.parse("2024-11-03T08:59:59Z")), -25200);
  assert.equal(offsetAt(pacific, Date.parse("2024-11-03T09:00:00Z")), -28800);

  assert.equal(localParts(Date.parse("2024-01-15T08:00:00Z"), pacific).hour, 0);
  assert.equal(localParts(Date.parse("2024-07-15T19:00:00Z"), pacific).hour, 12);
  assert.equal(localParts(Date.parse("2024-03-10T09:00:00Z"), pacific).hour, 1);
  assert.equal(localParts(Date.parse("2024-03-10T10:00:00Z"), pacific).hour, 3);
  assert.equal(localParts(Date.parse("2024-11-03T08:00:00Z"), pacific).hour, 1);
  assert.equal(localParts(Date.parse("2024-11-03T09:00:00Z"), pacific).hour, 1);
  assert.equal(localDateString(localParts(Date.parse("2024-01-15T08:00:00Z"), pacific)), "2024-01-15");
  assert.equal(localParts(Date.parse("2024-01-15T08:00:00Z"), pacific).weekday, 1);
});

test("southern-hemisphere DST wraps the year", () => {
  const tz = {
    tzOffset: 36000,
    dstOffset: 3600,
    dstStart: decodeDstRule("A40E2000"),
    dstEnd: decodeDstRule("440E2000"),
  };
  assert.equal(tz.dstStart.month, 10);
  assert.equal(tz.dstStart.operator, 2);
  assert.equal(tz.dstEnd.month, 4);
  const winter = offsetAt(tz, Date.parse("2024-07-01T00:00:00Z"));
  const summer = offsetAt(tz, Date.parse("2024-12-15T00:00:00Z"));
  assert.equal(winter, 36000);
  assert.equal(summer, 39600);
});
