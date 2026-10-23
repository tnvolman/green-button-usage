"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseContent } = require("./parse");
const { round6, money, daysInMonth } = require("./units");

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const store = new Map();

const PRIVACY =
  "In memory for this session only. Customer, address, and account fields are not included. " +
  "A meter ID with 6 or more digits is returned as **** plus its last 4 characters.";
const ESTIMATE_DISCLAIMER = "Estimate only. This is not a utility bill, a tariff, or a quote from the utility.";
const ACCOUNT_DIGIT_MIN = 6;

function meterIdHasAccountNumber(id) {
  const digits = String(id).match(/\d/g);
  return Boolean(digits && digits.length >= ACCOUNT_DIGIT_MIN);
}

function maskMeterId(id) {
  const text = String(id);
  if (!meterIdHasAccountNumber(text)) return text;
  return "****" + text.slice(-4);
}

function accountMeterPairs() {
  const ids = [];
  for (const dataset of store.values()) {
    for (const meter of dataset.meters) {
      if (meterIdHasAccountNumber(meter.id) && !ids.includes(meter.id)) ids.push(meter.id);
    }
  }
  ids.sort((a, b) => b.length - a.length);
  return ids.map((id) => [id, maskMeterId(id)]);
}

function scrub(value, pairs, key) {
  if (typeof value === "string") {
    if (key === "path") return value;
    let out = value;
    for (const [raw, masked] of pairs) {
      if (out.includes(raw)) out = out.split(raw).join(masked);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, pairs, null));
  if (value && typeof value === "object") {
    const out = {};
    for (const child of Object.keys(value)) out[child] = scrub(value[child], pairs, child);
    return out;
  }
  return value;
}

function present(value) {
  return scrub(value, accountMeterPairs(), null);
}

function canonicalMeterId(dataset, requested) {
  if (!requested) return requested;
  if (dataset.meters.some((meter) => meter.id === requested)) return requested;
  const matches = dataset.meters.filter((meter) => maskMeterId(meter.id) === requested);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error("More than one meter is returned as " + requested + ". Pass a meter ID only when it identifies one meter.");
  }
  return requested;
}

function clearStore() {
  store.clear();
}

function loadSummary(fileId) {
  const dataset = requireDataset(fileId);
  return {
    fileId: dataset.fileId,
    format: dataset.format,
    meters: dataset.meters.map((meter) => ({
      id: meter.id,
      usagePointId: meter.usagePointId,
      kind: meter.kind,
      unit: meter.unit,
      intervalSec: meter.intervalSec,
      tz: meter.tz,
      direction: meter.direction,
      readingCount: dataset.readings.filter((reading) => reading.meterId === meter.id).length,
    })),
    dateRange: dataset.dateRange,
    units: dataset.units,
    readingCount: dataset.readings.length,
    billPeriodCount: dataset.billPeriods.length,
    warnings: dataset.warnings,
    privacy: PRIVACY,
  };
}

function loadGreenbutton(args) {
  const input = readLoadInput(args || {});
  const dataset = parseContent(input.text, input.hint);
  const fileId = "gb_" + crypto.createHash("sha256").update(input.text).digest("hex").slice(0, 12);
  dataset.fileId = fileId;
  delete dataset._internal;
  store.set(fileId, dataset);
  return present(loadSummary(fileId));
}

function listUsagePoints(args) {
  const dataset = requireDataset(args && args.fileId);
  return present({
    fileId: dataset.fileId,
    usagePoints: dataset.usagePoints.map((point) => ({
      id: point.id,
      kind: point.kind,
      serviceCategory: point.serviceCategory,
      tz: point.tz,
      meters: dataset.meters
        .filter((meter) => meter.usagePointId === point.id)
        .map((meter) => ({
          id: meter.id,
          kind: meter.kind,
          unit: meter.unit,
          intervalSec: meter.intervalSec,
          direction: meter.direction,
          currency: meter.currency,
        })),
    })),
    privacy: PRIVACY,
  });
}

function usageSummary(args) {
  const dataset = requireDataset(args && args.fileId);
  const granularity = (args && args.granularity) || "day";
  if (!["day", "week", "month"].includes(granularity)) {
    throw new Error("granularity must be day, week, or month.");
  }
  const selected = selectReadings(dataset, args || {});
  const buckets = bucketize(selected.readings, granularity);
  return present({
    fileId: dataset.fileId,
    meterId: args && args.meterId ? args.meterId : null,
    granularity,
    direction: selected.direction,
    note: selected.note,
    unit: selected.unit,
    buckets,
    overall: overallFromBuckets(buckets, selected.readings),
    privacy: PRIVACY,
  });
}

function peakHours(args) {
  const dataset = requireDataset(args && args.fileId);
  const direction = args && args.direction;
  if (direction === "net" || direction === "all") {
    throw new Error('peak_hours keeps delivered and received separate. Pass direction "delivered" or "received".');
  }
  const selected = selectReadings(dataset, args || {});
  const readings = selected.readings;
  const limit = clampLimit(args && args.limit);
  const byValue = readings.slice().sort((a, b) => b.value - a.value || (a.startUtc < b.startUtc ? -1 : 1));
  const topIntervals = byValue.slice(0, limit).map(publicInterval);
  const byHour = [];
  for (let hour = 0; hour < 24; hour++) {
    const group = readings.filter((reading) => reading.localHour === hour);
    byHour.push({
      hour,
      avg: group.length ? round6(mean(group.map((reading) => reading.value))) : null,
      total: round6(sum(group.map((reading) => reading.value))),
      count: group.length,
    });
  }
  const weekday = dayPart(readings, (reading) => !isWeekend(reading));
  const weekend = dayPart(readings, (reading) => isWeekend(reading));
  const values = readings.map((reading) => reading.value).sort((a, b) => a - b);
  const quartileCount = values.length ? Math.max(1, Math.floor(values.length / 4)) : 0;
  const baseload = quartileCount ? round6(mean(values.slice(0, quartileCount))) : null;
  const peak = values.length ? values[values.length - 1] : null;
  const average = values.length ? round6(mean(values)) : null;
  const loadFactor = peak ? round6(average / peak) : null;
  return present({
    fileId: dataset.fileId,
    meterId: selected.meterId,
    unit: selected.unit,
    direction: selected.direction,
    note: selected.note,
    topIntervals,
    byHour,
    weekday,
    weekend,
    baseload,
    peak,
    average,
    loadFactor,
    definitions: {
      baseload: "Mean of the lowest quartile of interval values (at least one interval).",
      loadFactor: "Mean interval value divided by the peak interval value.",
      byHour: "Mean interval value for each local hour of the day.",
      weekday: "Monday through Friday, by the reading's local date. avgInterval is the mean interval; avgPerDay is the total divided by distinct local dates.",
      weekend: "Saturday and Sunday, same averages as weekday.",
    },
    privacy: PRIVACY,
  });
}

function comparePeriods(args) {
  const dataset = requireDataset(args && args.fileId);
  const input = args || {};
  const mode = input.mode || (input.periodA && input.periodB ? "ranges" : "");
  if (!["mom", "yoy", "ranges"].includes(mode)) {
    throw new Error('mode must be "mom", "yoy", or "ranges".');
  }
  const selected = selectReadings(dataset, input);
  let rangeA;
  let rangeB;
  if (mode === "ranges") {
    rangeA = explicitRange(input.periodA, "periodA");
    rangeB = explicitRange(input.periodB, "periodB");
  } else {
    const resolved = relativeRanges(selected.readings, mode);
    rangeA = resolved.a;
    rangeB = resolved.b;
  }
  const periodA = summarizeRange(selected.readings, rangeA);
  const periodB = summarizeRange(selected.readings, rangeB);
  return present({
    fileId: dataset.fileId,
    meterId: selected.meterId,
    mode,
    direction: selected.direction,
    note: selected.note,
    unit: selected.unit,
    periodA,
    periodB,
    delta: {
      total: round6(periodA.total - periodB.total),
      perDay: round6(periodA.perDay - periodB.perDay),
      percentTotal: periodB.total ? round6(((periodA.total - periodB.total) / periodB.total) * 100) : null,
      percentPerDay: periodB.perDay ? round6(((periodA.perDay - periodB.perDay) / periodB.perDay) * 100) : null,
    },
    normalization: "perDay divides the period total by the number of local calendar days in the window, so months of different lengths can be compared.",
    privacy: PRIVACY,
  });
}

function estimateCost(args) {
  const dataset = requireDataset(args && args.fileId);
  const input = args || {};
  if (input.direction === "net" || input.direction === "all") {
    throw new Error('estimate_cost uses one direction. Pass "delivered" or "received".');
  }
  const selected = selectReadings(dataset, input);
  const fixedMonthly = input.fixedMonthly == null ? 0 : Number(input.fixedMonthly);
  if (!Number.isFinite(fixedMonthly) || fixedMonthly < 0) {
    throw new Error("fixedMonthly must be a non-negative number.");
  }
  const useFileCost = input.useFileCost !== false;
  const fileCosts = selected.readings.filter((reading) => reading.cost != null);
  const hasFileCost = fileCosts.length > 0;
  const months = groupByMonth(selected.readings);
  const fixedByMonth = months.map((month) => ({
    month: month.key,
    fixed: money(fixedMonthly),
  }));
  const fixedTotal = money(fixedMonthly * months.length);
  let fileCost = null;
  if (useFileCost && hasFileCost) {
    const byMonth = months.map((month) => ({
      month: month.key,
      energy: money(sum(month.readings.map((reading) => reading.cost || 0))),
      fixed: money(fixedMonthly),
      total: money(sum(month.readings.map((reading) => reading.cost || 0)) + fixedMonthly),
    }));
    const energy = money(sum(fileCosts.map((reading) => reading.cost)));
    fileCost = {
      energy,
      fixed: fixedTotal,
      total: money(energy + fixedTotal),
      byMonth,
      partial: fileCosts.length !== selected.readings.length,
    };
  }
  let rateEstimate = null;
  if (input.rate) {
    rateEstimate = rateForReadings(selected.readings, input.rate, fixedMonthly, months);
  }
  if (!fileCost && !rateEstimate) {
    throw new Error("This file has no interval costs. Pass a rate (flat, tou, or tiers) to build an estimate.");
  }
  const primary = fileCost ? "file" : "rate";
  const total = fileCost ? fileCost.total : rateEstimate.total;
  return present({
    estimate: true,
    label: "estimate",
    disclaimer: ESTIMATE_DISCLAIMER,
    fileId: dataset.fileId,
    meterId: selected.meterId,
    direction: selected.direction,
    note: selected.note,
    unit: selected.unit,
    currency: currencyOf(selected.readings, input.rate),
    source: fileCost && rateEstimate ? "file+rate" : primary,
    primary,
    fileCost,
    rateEstimate,
    fixedMonthlyCharge: money(fixedMonthly),
    monthCount: months.length,
    total,
    privacy: PRIVACY,
  });
}

function exportNormalized(args) {
  const input = args || {};
  const dataset = requireDataset(input.fileId);
  if (typeof input.path !== "string" || !input.path.trim()) {
    throw new Error("path is required. export_normalized writes only to the path you give.");
  }
  const format = input.format === "csv" || input.format === "json" ? input.format : "";
  if (!format) throw new Error('format must be "csv" or "json".');
  const target = path.resolve(input.path.trim());
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error("The directory for that path does not exist.");
  }
  const exported = present(exportDocument(dataset));
  const body = format === "json" ? JSON.stringify(exported, null, 2) : toCsv(exported);
  const flag = input.overwrite === true ? "w" : "wx";
  try {
    fs.writeFileSync(target, body, { flag });
  } catch (err) {
    if (err && (err.code === "EEXIST" || err.code === "EISDIR")) {
      throw new Error("A file already exists at that path. Pass overwrite: true to replace it.");
    }
    throw err;
  }
  return present({
    path: target,
    format,
    bytes: Buffer.byteLength(body),
    readings: dataset.readings.length,
    billPeriods: dataset.billPeriods.length,
    privacy: PRIVACY,
  });
}

function exportDocument(dataset) {
  return {
    fileId: dataset.fileId,
    meters: dataset.meters,
    readings: dataset.readings,
    billPeriods: dataset.billPeriods,
    privacy: PRIVACY,
  };
}

function toCsv(dataset) {
  const header = [
    "recordType",
    "meterId",
    "usagePointId",
    "kind",
    "unit",
    "intervalSec",
    "startUtc",
    "endUtc",
    "localDate",
    "localHour",
    "value",
    "direction",
    "cost",
    "currency",
  ];
  const lines = [header.join(",")];
  const meterById = new Map(dataset.meters.map((meter) => [meter.id, meter]));
  for (const reading of dataset.readings) {
    const meter = meterById.get(reading.meterId) || {};
    lines.push(
      [
        "reading",
        reading.meterId,
        meter.usagePointId || "",
        meter.kind || "",
        meter.unit || "",
        meter.intervalSec == null ? "" : meter.intervalSec,
        reading.startUtc,
        reading.endUtc,
        reading.localDate,
        reading.localHour,
        reading.value,
        reading.direction,
        reading.cost == null ? "" : reading.cost,
        reading.currency || "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  for (const bill of dataset.billPeriods) {
    lines.push(
      [
        "bill",
        "",
        bill.usagePointId || "",
        "",
        bill.unit || "",
        "",
        bill.startUtc,
        bill.endUtc,
        "",
        "",
        bill.consumption == null ? "" : bill.consumption,
        "",
        bill.cost == null ? "" : bill.cost,
        bill.currency || "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function readLoadInput(args) {
  const keys = ["path", "xml_text", "csv_text"].filter((key) => typeof args[key] === "string" && args[key].trim() !== "");
  if (keys.length !== 1) throw new Error("Provide exactly one of path, xml_text, or csv_text.");
  const extra = Object.keys(args).filter((key) => !["path", "xml_text", "csv_text"].includes(key));
  if (extra.length) throw new Error("Unknown argument: " + extra.join(", "));
  if (keys[0] === "path") {
    const target = path.resolve(args.path.trim());
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error("No file at that path.");
    }
    const stat = fs.statSync(target);
    if (stat.size > MAX_FILE_BYTES) throw new Error("File is larger than 32 MB.");
    const buffer = fs.readFileSync(target);
    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      throw new Error("This file is a zip archive. Unzip it and pass the XML or CSV inside. This plugin does not read zip files.");
    }
    return { text: buffer.toString("utf8"), hint: path.extname(target).slice(1) };
  }
  if (args[keys[0]].length > MAX_FILE_BYTES) throw new Error("That text is larger than 32 MB. Pass a path instead.");
  return { text: args[keys[0]], hint: keys[0] === "csv_text" ? "csv" : "xml" };
}

function requireDataset(fileId) {
  if (fileId) {
    const dataset = store.get(fileId);
    if (!dataset) throw new Error("No loaded file with that id. Call load_greenbutton first.");
    return dataset;
  }
  if (store.size === 1) return store.values().next().value;
  if (store.size === 0) throw new Error("No Green Button file is loaded. Call load_greenbutton with a local path first.");
  throw new Error("More than one file is loaded. Pass fileId. Loaded ids: " + [...store.keys()].join(", "));
}

function selectReadings(dataset, args) {
  let readings = dataset.readings.slice();
  let meterId = null;
  if (args.meterId) {
    meterId = canonicalMeterId(dataset, args.meterId);
    const meter = dataset.meters.find((item) => item.id === meterId);
    if (!meter) throw new Error("No meter with id " + meterId + ".");
    readings = readings.filter((reading) => reading.meterId === meterId);
  }
  if (args.usagePointId) {
    const point = dataset.usagePoints.find((item) => item.id === args.usagePointId);
    if (!point) throw new Error("No usage point with id " + args.usagePointId + ".");
    const ids = new Set(point.meterIds);
    readings = readings.filter((reading) => ids.has(reading.meterId));
  }
  let note = null;
  let direction = args.direction || null;
  const unitSource = readings.slice();
  if (direction === "net") {
    const units = [...new Set(unitSource.map((reading) => meterUnit(dataset, reading.meterId)))];
    if (units.length > 1) throw new Error("Those readings use more than one unit (" + units.join(", ") + "). Pass meterId.");
    return {
      readings: netReadings(readings),
      direction: "net",
      note: "Net is delivered minus received for intervals that share a start time.",
      unit: units[0] || null,
      meterId,
    };
  } else if (direction === "all") {
    note = "Showing every direction.";
  } else if (direction) {
    readings = readings.filter((reading) => reading.direction === direction);
  } else {
    const hasDelivered = readings.some((reading) => reading.direction === "delivered");
    const hasOther = readings.some((reading) => reading.direction !== "delivered");
    if (hasDelivered && hasOther) {
      readings = readings.filter((reading) => reading.direction === "delivered");
      direction = "delivered";
      note = 'Showing delivered only so solar export stays separate. Pass direction "received" for export.';
    } else if (hasDelivered) direction = "delivered";
    else if (readings[0]) direction = readings[0].direction;
  }
  const units = [...new Set(readings.map((reading) => meterUnit(dataset, reading.meterId)))];
  if (units.length > 1) {
    throw new Error("Those readings use more than one unit (" + units.join(", ") + "). Pass meterId.");
  }
  return {
    readings,
    direction: direction || "delivered",
    note,
    unit: units[0] || (dataset.meters[0] && dataset.meters[0].unit) || null,
    meterId,
  };
}

function meterUnit(dataset, meterId) {
  const meter = dataset.meters.find((item) => item.id === meterId);
  return meter ? meter.unit : "unknown";
}

function bucketKey(reading, granularity) {
  if (granularity === "month") return reading.localDate.slice(0, 7);
  if (granularity === "day") return reading.localDate;
  const date = parseLocalDate(reading.localDate);
  const weekday = date.getUTCDay();
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return date.toISOString().slice(0, 10);
}

function bucketize(readings, granularity) {
  const map = new Map();
  for (const reading of readings) {
    const key = bucketKey(reading, granularity);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(reading);
  }
  return [...map.keys()].sort().map((key) => {
    const group = map.get(key);
    const values = group.map((reading) => reading.value);
    const costs = group.filter((reading) => reading.cost != null);
    return {
      key,
      total: round6(sum(values)),
      avg: round6(mean(values)),
      min: round6(Math.min(...values)),
      max: round6(Math.max(...values)),
      count: group.length,
      cost: costs.length ? money(sum(costs.map((reading) => reading.cost))) : null,
    };
  });
}

function overallFromBuckets(buckets, readings) {
  if (!buckets.length) {
    return { total: 0, avg: null, min: null, max: null, bucketCount: 0, intervalCount: 0 };
  }
  const totals = buckets.map((bucket) => bucket.total);
  return {
    total: round6(sum(readings.map((reading) => reading.value))),
    avg: round6(mean(totals)),
    min: round6(Math.min(...totals)),
    max: round6(Math.max(...totals)),
    bucketCount: buckets.length,
    intervalCount: readings.length,
  };
}

function publicInterval(reading) {
  return {
    meterId: reading.meterId,
    startUtc: reading.startUtc,
    endUtc: reading.endUtc,
    localDate: reading.localDate,
    localHour: reading.localHour,
    value: reading.value,
    direction: reading.direction,
    cost: reading.cost,
    weekday: weekdayName(weekdayOf(reading.localDate)),
  };
}

function dayPart(readings, predicate) {
  const group = readings.filter(predicate);
  const days = new Set(group.map((reading) => reading.localDate));
  const total = sum(group.map((reading) => reading.value));
  return {
    total: round6(total),
    avgInterval: group.length ? round6(mean(group.map((reading) => reading.value))) : null,
    avgPerDay: days.size ? round6(total / days.size) : null,
    intervalCount: group.length,
    days: days.size,
  };
}

function isWeekend(reading) {
  const day = weekdayOf(reading.localDate);
  return day === 0 || day === 6;
}

function weekdayOf(localDate) {
  const date = parseLocalDate(localDate);
  return date.getUTCDay();
}

function weekdayName(day) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day];
}

function parseLocalDate(text) {
  const [year, month, day] = text.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function explicitRange(value, label) {
  if (!value || typeof value !== "object" || !value.start || !value.end) {
    throw new Error(label + " needs start and end.");
  }
  const startDate = dateOnly(value.start);
  const endDate = dateOnly(value.end);
  if (startDate && endDate) {
    const endExclusive = addLocalDays(endDate, 1);
    if (!(startDate < endExclusive)) throw new Error(label + " end must be on or after start.");
    return { kind: "dates", startDate, endDate: endExclusive, label: startDate + ".." + endDate };
  }
  const startMs = parseInstant(value.start);
  const endMs = parseInstant(value.end);
  if (!(startMs < endMs)) throw new Error(label + " end must be after start.");
  return { kind: "instant", startMs, endMs, label: label === "periodA" ? "A" : "B" };
}

function dateOnly(value) {
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function parseInstant(value) {
  const ms = Date.parse(String(value).trim());
  if (!Number.isFinite(ms)) throw new Error("Could not parse date " + value + ".");
  return ms;
}

function addLocalDays(text, days) {
  const date = parseLocalDate(text);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function relativeRanges(readings, mode) {
  if (!readings.length) throw new Error("There are no readings to compare.");
  const months = completeMonths(readings);
  if (mode === "mom") {
    if (months.length < 2) throw new Error("Not enough data for month-over-month. Need two complete calendar months.");
    const later = months[months.length - 1];
    const earlier = months[months.length - 2];
    return { a: monthRange(later), b: monthRange(earlier) };
  }
  const later = months[months.length - 1];
  const earlierKey = shiftMonth(later, -12);
  if (!months.includes(earlierKey)) {
    throw new Error("Not enough data for year-over-year. Need the same calendar month in the previous year.");
  }
  return { a: monthRange(later), b: monthRange(earlierKey) };
}

function completeMonths(readings) {
  const dates = readings.map((reading) => reading.localDate).sort();
  const min = dates[0];
  const max = dates[dates.length - 1];
  const present = new Set(dates.map((date) => date.slice(0, 7)));
  return [...present].sort().filter((key) => {
    const [year, month] = key.split("-").map(Number);
    const last = String(daysInMonth(year, month)).padStart(2, "0");
    return min <= key + "-01" && max >= key + "-" + last;
  });
}

function monthRange(key) {
  const [year, month] = key.split("-").map(Number);
  const last = String(daysInMonth(year, month)).padStart(2, "0");
  return {
    kind: "dates",
    startDate: key + "-01",
    endDate: addLocalDays(key + "-" + last, 1),
    label: key,
  };
}

function shiftMonth(key, delta) {
  const [year, month] = key.split("-").map(Number);
  const index = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return nextYear + "-" + String(nextMonth).padStart(2, "0");
}

function summarizeRange(readings, range) {
  const inside =
    range.kind === "dates"
      ? readings.filter((reading) => reading.localDate >= range.startDate && reading.localDate < range.endDate)
      : readings.filter((reading) => {
          const start = Date.parse(reading.startUtc);
          return start >= range.startMs && start < range.endMs;
        });
  const total = sum(inside.map((reading) => reading.value));
  const calendarDays = range.kind === "dates" ? localDayCount(range.startDate, range.endDate) : utcDayCount(range.startMs, range.endMs);
  const covered = new Set(inside.map((reading) => reading.localDate));
  const first = inside[0];
  const last = inside[inside.length - 1];
  return {
    label: range.label,
    startLocal: range.kind === "dates" ? range.startDate : null,
    endLocal: range.kind === "dates" ? addLocalDays(range.endDate, -1) : null,
    startUtc: first ? first.startUtc : null,
    endUtc: last ? last.endUtc : null,
    days: calendarDays,
    daysWithData: covered.size,
    total: round6(total),
    perDay: calendarDays ? round6(total / calendarDays) : null,
    intervalCount: inside.length,
  };
}

function localDayCount(startDate, endDate) {
  const start = parseLocalDate(startDate).getTime();
  const end = parseLocalDate(endDate).getTime();
  return Math.round((end - start) / 86400000);
}

function utcDayCount(startMs, endMs) {
  return Math.max(1, Math.round((endMs - startMs) / 86400000));
}

function netReadings(readings) {
  const map = new Map();
  for (const reading of readings) {
    const key = reading.startUtc;
    if (!map.has(key)) {
      map.set(key, {
        meterId: reading.meterId,
        startUtc: reading.startUtc,
        endUtc: reading.endUtc,
        localHour: reading.localHour,
        localDate: reading.localDate,
        value: 0,
        direction: "net",
        cost: null,
        currency: reading.currency,
      });
    }
    const row = map.get(key);
    if (reading.direction === "received") row.value = round6(row.value - reading.value);
    else row.value = round6(row.value + reading.value);
  }
  return [...map.values()];
}

function groupByMonth(readings) {
  const map = new Map();
  for (const reading of readings) {
    const key = reading.localDate.slice(0, 7);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(reading);
  }
  return [...map.keys()].sort().map((key) => ({ key, readings: map.get(key) }));
}

function rateForReadings(readings, rate, fixedMonthly, months) {
  if (!rate || typeof rate !== "object") throw new Error("rate must be an object.");
  const type = rate.type;
  if (!["flat", "tou", "tiers"].includes(type)) throw new Error('rate.type must be "flat", "tou", or "tiers".');
  const byMonth = [];
  for (const month of months) {
    let energy = 0;
    if (type === "flat") {
      const price = requirePrice(rate.pricePerUnit, "pricePerUnit");
      energy = sum(month.readings.map((reading) => reading.value)) * price;
    } else if (type === "tou") {
      energy = touCost(month.readings, rate);
    } else {
      energy = tierCost(sum(month.readings.map((reading) => reading.value)), rate.tiers);
    }
    byMonth.push({
      month: month.key,
      energy: money(energy),
      fixed: money(fixedMonthly),
      total: money(energy + fixedMonthly),
    });
  }
  const energy = money(sum(byMonth.map((month) => month.energy)));
  const fixed = money(fixedMonthly * months.length);
  return {
    method: type,
    energy,
    fixed,
    total: money(energy + fixed),
    byMonth,
  };
}

function touCost(readings, rate) {
  const offPeak = requirePrice(rate.offPeakPrice, "offPeakPrice");
  const windows = Array.isArray(rate.windows) ? rate.windows : [];
  if (!windows.length) throw new Error("tou rate needs at least one window.");
  let cost = 0;
  for (const reading of readings) {
    const match = windows.find((window) => windowMatches(reading, window));
    const price = match ? requirePrice(match.pricePerUnit, "window.pricePerUnit") : offPeak;
    cost += reading.value * price;
  }
  return cost;
}

function windowMatches(reading, window) {
  const start = Number(window.startHour);
  const end = Number(window.endHour);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  const days = window.days || "all";
  const weekend = isWeekend(reading);
  if (days === "weekday" && weekend) return false;
  if (days === "weekend" && !weekend) return false;
  if (days !== "all" && days !== "weekday" && days !== "weekend") {
    throw new Error('window.days must be "all", "weekday", or "weekend".');
  }
  const hour = reading.localHour;
  if (start === end) return false;
  if (end === 24 || (end > start && end <= 24)) return hour >= start && hour < end;
  if (end < start) return hour >= start || hour < end;
  return false;
}

function tierCost(usage, tiers) {
  if (!Array.isArray(tiers) || !tiers.length) throw new Error("tiers rate needs a tiers array.");
  const ordered = tiers.slice().sort((a, b) => {
    if (a.upTo == null) return 1;
    if (b.upTo == null) return -1;
    return Number(a.upTo) - Number(b.upTo);
  });
  let remaining = usage;
  let previous = 0;
  let cost = 0;
  for (const tier of ordered) {
    const price = requirePrice(tier.pricePerUnit, "tier.pricePerUnit");
    const cap = tier.upTo == null ? Infinity : Number(tier.upTo);
    if (!Number.isFinite(cap) && tier.upTo != null) throw new Error("tier.upTo must be a number or null.");
    const room = cap - previous;
    const used = Math.min(remaining, room);
    if (used > 0) cost += used * price;
    remaining -= used > 0 ? used : 0;
    previous = cap;
    if (remaining <= 1e-9) break;
  }
  return cost;
}

function requirePrice(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(label + " must be a number.");
  return n;
}

function currencyOf(readings, rate) {
  const found = readings.find((reading) => reading.currency);
  if (found) return found.currency;
  if (rate && typeof rate.currency === "string") return rate.currency;
  return "USD";
}

function clampLimit(value) {
  if (value == null) return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("limit must be an integer from 1 to 100.");
  return n;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  if (!values.length) return null;
  return sum(values) / values.length;
}

function dispatchTool(name, args) {
  if (name === "load_greenbutton") return loadGreenbutton(args);
  if (name === "list_usage_points") return listUsagePoints(args);
  if (name === "usage_summary") return usageSummary(args);
  if (name === "peak_hours") return peakHours(args);
  if (name === "compare_periods") return comparePeriods(args);
  if (name === "estimate_cost") return estimateCost(args);
  if (name === "export_normalized") return exportNormalized(args);
  const error = new Error("Unknown tool " + name + ".");
  error.code = "tool";
  throw error;
}

module.exports = {
  PRIVACY,
  ESTIMATE_DISCLAIMER,
  clearStore,
  loadGreenbutton,
  listUsagePoints,
  usageSummary,
  peakHours,
  comparePeriods,
  estimateCost,
  exportNormalized,
  dispatchTool,
  daysInMonth,
};
