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

test("account numbers in meter ids are masked to the last 4 characters", () => {
  const fullId = "990000001234";
  const xml = feed(
    usagePoint(0) +
      localTime(0) +
      meter(fullId) +
      readingType("RT", 1, 999, 0, 3600, 840) +
      intervalBlock([
        { start: unix("2024-01-15T00:00:00Z"), duration: 3600, value: 1000, cost: 100000 },
        { start: unix("2024-01-16T00:00:00Z"), duration: 3600, value: 2000, cost: 200000 },
      ])
  );
  assert.equal(xml.includes(fullId), true);
  const loaded = loadGreenbutton({ xml_text: xml });
  const listed = listUsagePoints({});
  const byMask = usageSummary({ meterId: "****1234", granularity: "day" });
  const byRaw = usageSummary({ meterId: fullId, granularity: "day" });
  const peaks = peakHours({ meterId: "****1234", limit: 2 });
  const compared = comparePeriods({
    meterId: "****1234",
    mode: "ranges",
    periodA: { start: "2024-01-15", end: "2024-01-15" },
    periodB: { start: "2024-01-16", end: "2024-01-16" },
  });
  const cost = estimateCost({ meterId: fullId });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-mask-"));
  const jsonPath = path.join(dir, "out.json");
  const csvPath = path.join(dir, "out.csv");
  const jsonExport = exportNormalized({ path: jsonPath, format: "json" });
  const csvExport = exportNormalized({ path: csvPath, format: "csv" });
  const jsonFile = fs.readFileSync(jsonPath, "utf8");
  const csvFile = fs.readFileSync(csvPath, "utf8");
  const outputs = [loaded, listed, byMask, byRaw, peaks, compared, cost, jsonExport, csvExport, jsonFile, csvFile];
  const blob = JSON.stringify(outputs);
  assert.equal(blob.includes(fullId), false);
  assert.equal(loaded.meters[0].id, "****1234");
  assert.equal(listed.usagePoints[0].meters[0].id, "****1234");
  assert.equal(byMask.meterId, "****1234");
  assert.equal(byRaw.meterId, "****1234");
  assert.equal(byMask.overall.total, byRaw.overall.total);
  assert.equal(peaks.meterId, "****1234");
  assert.equal(peaks.topIntervals[0].meterId, "****1234");
  assert.equal(compared.meterId, "****1234");
  assert.equal(cost.meterId, "****1234");
  assert.equal(jsonExport.path, jsonPath);
  assert.equal(jsonFile.includes("****1234"), true);
  assert.equal(csvFile.includes("****1234"), true);
  const warning = loaded.warnings.find((item) => item.code === "unknown-uom");
  assert.ok(warning);
  assert.equal(warning.message.includes(fullId), false);
  assert.equal(warning.message.includes("****1234"), true);
});

test("a meter id with a 6-digit account number is masked and a 5-digit id is not", () => {
  const six = "654321";
  const five = "12345";
  const sixLoaded = loadGreenbutton({
    xml_text: feed(
      usagePoint(0) +
        localTime(0) +
        meter(six) +
        readingType("RT", 1, 72, 0, 3600, 840) +
        intervalBlock([{ start: unix("2024-03-01T00:00:00Z"), duration: 3600, value: 1000, cost: 100000 }])
    ),
  });
  assert.equal(sixLoaded.meters[0].id, "****4321");
  assert.equal(JSON.stringify(sixLoaded).includes(six), false);
  clearStore();
  const fiveLoaded = loadGreenbutton({
    xml_text: feed(
      usagePoint(0) +
        localTime(0) +
        meter(five) +
        readingType("RT", 1, 72, 0, 3600, 840) +
        intervalBlock([{ start: unix("2024-03-01T00:00:00Z"), duration: 3600, value: 1000, cost: 100000 }])
    ),
  });
  assert.equal(fiveLoaded.meters[0].id, five);
});

test("a prefixed meter id and a CSV meter column do not leak the account number", () => {
  const fullId = "METER-990000005678";
  const loaded = loadGreenbutton({
    xml_text: feed(
      usagePoint(0) +
        localTime(0) +
        meter(fullId) +
        readingType("RT", 1, 72, 0, 3600, 840) +
        intervalBlock([{ start: unix("2024-04-02T12:00:00Z"), duration: 3600, value: 2500, cost: 50000 }])
    ),
  });
  assert.equal(loaded.meters[0].id, "****5678");
  assert.equal(JSON.stringify(loaded).includes(fullId), false);
  assert.equal(JSON.stringify(loaded).includes("990000005678"), false);
  clearStore();
  const csvId = "990000001234";
  const csv = loadGreenbutton({
    csv_text: "Name,Synthetic Person\nAccount Number,ACCT-998877\n\nDate,Usage,Meter\n2024-07-01,1.25," + csvId + "\n",
  });
  const listed = listUsagePoints({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-mask-csv-"));
  const jsonPath = path.join(dir, "out.json");
  exportNormalized({ path: jsonPath, format: "json" });
  const blob = JSON.stringify(csv) + JSON.stringify(listed) + fs.readFileSync(jsonPath, "utf8");
  assert.equal(blob.includes(csvId), false);
  assert.equal(blob.includes("ACCT-998877"), false);
  assert.equal(blob.includes("Synthetic Person"), false);
  assert.equal(csv.meters[0].id, "****1234");
  assert.equal(listed.usagePoints[0].id.includes(csvId), false);
  assert.equal(listed.usagePoints[0].meters[0].id, "****1234");
});

test("two meter ids that mask to the same value do not reveal either full id", () => {
  const first = "111111111234";
  const second = "222222221234";
  const loaded = loadGreenbutton({
    xml_text: feed(
      usagePoint(0) +
        localTime(0) +
        meter(first) +
        readingType("A", 1, 72, 0, 3600, 840) +
        intervalBlock([{ start: unix("2024-07-01T19:00:00Z"), duration: 3600, value: 5000, cost: 100000 }]) +
        meter(second) +
        readingType("B", 1, 72, 0, 3600, 840) +
        intervalBlock([{ start: unix("2024-07-01T20:00:00Z"), duration: 3600, value: 2000, cost: 20000 }])
    ),
  });
  const blob = JSON.stringify(loaded);
  assert.equal(blob.includes(first), false);
  assert.equal(blob.includes(second), false);
  assert.equal(loaded.meters.length, 2);
  assert.deepEqual(
    loaded.meters.map((meter) => meter.id),
    ["****1234", "****1234"]
  );
  assert.throws(() => usageSummary({ meterId: "****1234", granularity: "day" }), (err) => {
    assert.equal(String(err.message).includes(first), false);
    assert.equal(String(err.message).includes(second), false);
    assert.match(err.message, /More than one meter is returned as \*\*\*\*1234/);
    return true;
  });
  const picked = usageSummary({ meterId: first, granularity: "day" });
  const pickedBlob = JSON.stringify(picked);
  assert.equal(pickedBlob.includes(first), false);
  assert.equal(pickedBlob.includes(second), false);
  assert.equal(picked.meterId, "****1234");
  assert.equal(picked.overall.total, 5);
});

test("export_normalized refuses to overwrite an existing file unless overwrite is true", () => {
  loadGreenbutton({ xml_text: twoDayFile() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-overwrite-"));
  const target = path.join(dir, "out.json");
  fs.writeFileSync(target, "original");
  assert.throws(() => exportNormalized({ path: target, format: "json" }), /overwrite: true/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.throws(() => exportNormalized({ path: target, format: "json", overwrite: false }), /overwrite: true/);
  assert.throws(() => exportNormalized({ path: target, format: "json", overwrite: "true" }), /overwrite: true/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  const replaced = exportNormalized({ path: target, format: "json", overwrite: true });
  const body = fs.readFileSync(target, "utf8");
  assert.equal(replaced.path, target);
  assert.notEqual(body, "original");
  assert.equal(body.includes("HOUSE"), true);
  assert.equal(body.includes("original"), false);
  const fresh = path.join(dir, "fresh.csv");
  const created = exportNormalized({ path: fresh, format: "csv" });
  assert.equal(created.format, "csv");
  assert.equal(fs.readFileSync(fresh, "utf8").includes("HOUSE"), true);
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
