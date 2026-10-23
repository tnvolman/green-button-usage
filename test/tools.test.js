"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  clearStore,
  loadGreenbutton,
  listUsagePoints,
  usageSummary,
  peakHours,
  comparePeriods,
  estimateCost,
  exportNormalized,
} = require("../server/tools");
const { feed, localTime, readingType, intervalBlock, usagePoint, meter, unix } = require("./helpers");

function hourReading(iso, kwh, cost) {
  return { start: unix(iso), duration: 3600, value: Math.round(kwh * 1000), cost: cost == null ? null : cost };
}

function twoDayFile() {
  const readings = [];
  for (let hour = 0; hour < 24; hour++) {
    const iso = "2024-01-15T" + String(hour).padStart(2, "0") + ":00:00Z";
    readings.push(hourReading(iso, hour + 1, 50000));
  }
  for (let hour = 0; hour < 24; hour++) {
    const iso = "2024-01-20T" + String(hour).padStart(2, "0") + ":00:00Z";
    readings.push(hourReading(iso, 2, 50000));
  }
  return feed(
    usagePoint(0) +
      localTime(0) +
      meter("HOUSE") +
      readingType("RT", 1, 72, 0, 3600, 840) +
      intervalBlock(readings)
  );
}

test.beforeEach(() => {
  clearStore();
});

test("each tool runs on a small delivered series", () => {
  const loaded = loadGreenbutton({ xml_text: twoDayFile() });
  assert.match(loaded.fileId, /^gb_[0-9a-f]{12}$/);
  assert.equal(loaded.readingCount, 48);
  assert.equal(loaded.meters[0].id, "HOUSE");
  assert.equal(loaded.meters[0].unit, "kWh");
  assert.equal(loaded.privacy.includes("In memory"), true);

  const points = listUsagePoints({});
  assert.equal(points.usagePoints[0].kind, "electric");
  assert.equal(points.usagePoints[0].serviceCategory, 0);
  assert.deepEqual(points.usagePoints[0].meters.map((item) => item.id), ["HOUSE"]);

  const days = usageSummary({ granularity: "day" });
  assert.equal(days.buckets.length, 2);
  assert.equal(days.buckets[0].key, "2024-01-15");
  assert.equal(days.buckets[0].total, 300);
  assert.equal(days.buckets[1].total, 48);
  assert.equal(days.overall.total, 348);
  assert.equal(days.overall.avg, 174);
  assert.equal(days.overall.min, 48);
  assert.equal(days.overall.max, 300);

  const week = usageSummary({ granularity: "week" });
  assert.equal(week.buckets.length, 1);
  assert.equal(week.buckets[0].total, 348);

  const month = usageSummary({ granularity: "month" });
  assert.equal(month.buckets[0].key, "2024-01");
  assert.equal(month.buckets[0].total, 348);

  const peaks = peakHours({ limit: 3 });
  assert.equal(peaks.topIntervals[0].value, 24);
  assert.equal(peaks.topIntervals[0].localHour, 23);
  assert.equal(peaks.topIntervals[0].weekday, "Monday");
  assert.equal(peaks.byHour[0].avg, 1.5);
  assert.equal(peaks.weekday.total, 300);
  assert.equal(peaks.weekday.days, 1);
  assert.equal(peaks.weekend.total, 48);
  assert.equal(peaks.baseload, 1.916667);
  assert.equal(peaks.peak, 24);
  assert.equal(peaks.average, 7.25);
  assert.equal(peaks.loadFactor, 0.302083);

  const compared = comparePeriods({
    mode: "ranges",
    periodA: { start: "2024-01-15", end: "2024-01-15" },
    periodB: { start: "2024-01-20", end: "2024-01-20" },
  });
  assert.equal(compared.periodA.total, 300);
  assert.equal(compared.periodA.days, 1);
  assert.equal(compared.periodA.perDay, 300);
  assert.equal(compared.periodB.total, 48);
  assert.equal(compared.periodB.perDay, 48);
  assert.equal(compared.delta.perDay, 252);
  assert.equal(compared.normalization.includes("perDay"), true);

  const fromFile = estimateCost({ fixedMonthly: 5 });
  assert.equal(fromFile.estimate, true);
  assert.equal(fromFile.label, "estimate");
  assert.match(fromFile.disclaimer, /not a utility bill/);
  assert.equal(fromFile.primary, "file");
  assert.equal(fromFile.fileCost.energy, 24);
  assert.equal(fromFile.total, 29);

  const flat = estimateCost({
    useFileCost: false,
    fixedMonthly: 5,
    rate: { type: "flat", pricePerUnit: 0.1 },
  });
  assert.equal(flat.primary, "rate");
  assert.equal(flat.rateEstimate.method, "flat");
  assert.equal(flat.rateEstimate.energy, 34.8);
  assert.equal(flat.total, 39.8);

  const tou = estimateCost({
    useFileCost: false,
    rate: {
      type: "tou",
      offPeakPrice: 0,
      windows: [{ startHour: 16, endHour: 21, days: "weekday", pricePerUnit: 1 }],
    },
  });
  assert.equal(tou.rateEstimate.energy, 95);
  assert.equal(tou.total, 95);

  const tiers = estimateCost({
    useFileCost: false,
    rate: {
      type: "tiers",
      tiers: [
        { upTo: 100, pricePerUnit: 0.1 },
        { upTo: null, pricePerUnit: 0.2 },
      ],
    },
  });
  assert.equal(tiers.rateEstimate.energy, 59.6);

  const both = estimateCost({
    fixedMonthly: 0,
    rate: { type: "flat", pricePerUnit: 1 },
  });
  assert.equal(both.source, "file+rate");
  assert.equal(both.primary, "file");
  assert.equal(both.total, 24);
  assert.equal(both.rateEstimate.energy, 348);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-export-"));
  const jsonPath = path.join(dir, "out.json");
  const csvPath = path.join(dir, "out.csv");
  const jsonResult = exportNormalized({ path: jsonPath, format: "json" });
  const csvResult = exportNormalized({ path: csvPath, format: "csv" });
  assert.equal(jsonResult.readings, 48);
  const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(json.readings.length, 48);
  assert.equal(json.meters[0].id, "HOUSE");
  assert.equal(JSON.stringify(json).includes("Secret"), false);
  const csv = fs.readFileSync(csvPath, "utf8");
  assert.match(csv, /^recordType,meterId,/);
  assert.equal(csv.split("\n").filter((line) => line.startsWith("reading,")).length, 48);
  assert.equal(csvResult.format, "csv");
});

test("received export stays out of the delivered total", () => {
  const xml = feed(
    usagePoint(0) +
      localTime(0) +
      meter("IN") +
      readingType("IN", 1, 72, 0, 3600, 840) +
      intervalBlock([{ start: unix("2024-07-01T19:00:00Z"), duration: 3600, value: 5000, cost: 100000 }]) +
      meter("OUT") +
      readingType("OUT", 19, 72, 0, 3600, 840) +
      intervalBlock([{ start: unix("2024-07-01T19:00:00Z"), duration: 3600, value: 2000, cost: -20000 }])
  );
  loadGreenbutton({ xml_text: xml });
  const delivered = usageSummary({ granularity: "day" });
  assert.equal(delivered.direction, "delivered");
  assert.equal(delivered.overall.total, 5);
  assert.match(delivered.note, /delivered only/);
  const received = usageSummary({ meterId: "OUT", granularity: "day" });
  assert.equal(received.direction, "received");
  assert.equal(received.overall.total, 2);
  const net = usageSummary({ direction: "net", granularity: "day" });
  assert.equal(net.overall.total, 3);
});

test("month and year comparisons use complete local months and per-day totals", () => {
  const loaded = loadGreenbutton({ path: path.join(__dirname, "..", "samples", "electric-hourly.xml") });
  const mom = comparePeriods({ fileId: loaded.fileId, meterId: "DELIVERED", mode: "mom" });
  assert.equal(mom.periodA.label, "2025-01");
  assert.equal(mom.periodB.label, "2024-12");
  assert.equal(mom.periodA.days, 31);
  assert.equal(mom.periodB.days, 31);
  const month = usageSummary({ fileId: loaded.fileId, meterId: "DELIVERED", granularity: "month" });
  const january = month.buckets.find((bucket) => bucket.key === "2025-01").total;
  const december = month.buckets.find((bucket) => bucket.key === "2024-12").total;
  assert.equal(mom.periodA.total, january);
  assert.equal(mom.periodB.total, december);
  assert.equal(mom.periodA.perDay, Math.round((january / 31) * 1e6) / 1e6);

  const yoy = comparePeriods({ fileId: loaded.fileId, meterId: "DELIVERED", mode: "yoy" });
  assert.equal(yoy.periodA.label, "2025-01");
  assert.equal(yoy.periodB.label, "2024-01");
  const prior = month.buckets.find((bucket) => bucket.key === "2024-01").total;
  assert.equal(yoy.periodB.total, prior);
  assert.equal(yoy.periodA.days, 31);
  assert.equal(yoy.periodB.days, 31);
});

test("load rejects a zip and does not write during load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-zip-"));
  const zipPath = path.join(dir, "data.zip");
  fs.writeFileSync(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.throws(() => loadGreenbutton({ path: zipPath }), /zip archive/);
  assert.throws(() => loadGreenbutton({}), /exactly one/);
  assert.throws(() => estimateCost({}), /No Green Button file/);
  const original = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (...writeArgs) => {
    writes += 1;
    return original.apply(fs, writeArgs);
  };
  try {
    loadGreenbutton({
      xml_text: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    });
    assert.equal(writes, 0);
  } finally {
    fs.writeFileSync = original;
  }
});
