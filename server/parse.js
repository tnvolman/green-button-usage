"use strict";

const {
  COLLECTION_NAMES,
  serviceKindName,
  serviceKindCode,
  flowDirectionName,
  currencyName,
  normalizeQuantity,
  costToCurrency,
  decodeDstRule,
  localParts,
  localDateString,
  isoUtc,
  round6,
  emptyTz,
} = require("./units");
const {
  parseXml,
  localName,
  childElements,
  firstChild,
  childText,
  integerText,
} = require("./xml");

const RESOURCE_NAMES = new Set([
  "UsagePoint",
  "MeterReading",
  "ReadingType",
  "IntervalBlock",
  "LocalTimeParameters",
  "UsageSummary",
  "ElectricPowerUsageSummary",
]);

const PII_TYPES = new Set([
  "Customer",
  "CustomerAccount",
  "CustomerAgreement",
  "CustomerBillingInfo",
  "ServiceLocation",
  "UsagePointLocation",
  "ServiceDeliveryPoint",
  "MainAddress",
  "StreetAddress",
  "StreetDetail",
  "TownDetail",
  "PostalCode",
  "ElectronicAddress",
  "TelephoneNumber",
]);

const PII_FIELDS = new Set([
  "accountid",
  "accountnumber",
  "name",
  "fullname",
  "firstname",
  "lastname",
  "street",
  "streetdetail",
  "address",
  "addressgeneral",
  "city",
  "towndetail",
  "postalcode",
  "postcode",
  "email",
  "phone",
  "telephone",
]);

function warn(list, code, message) {
  if (list.some((item) => item.code === code && item.message === message)) return;
  list.push({ code, message });
}

function normHref(href) {
  if (!href) return "";
  let h = String(href).trim();
  if (!h) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !/^urn:/i.test(h)) {
    try {
      const url = new URL(h);
      h = url.pathname || "";
    } catch (_err) {
      /* keep the raw string */
    }
  }
  h = h.split("?")[0].split("#")[0];
  if (h.length > 1 && h.endsWith("/")) h = h.slice(0, -1);
  return h;
}

function pathParts(href) {
  return normHref(href).split("/").filter(Boolean);
}

function lastSegment(href) {
  const parts = pathParts(href);
  return parts.length ? parts[parts.length - 1] : "";
}

function safeId(value, fallback) {
  if (!value) return fallback;
  const text = String(value).trim();
  const segment = text.includes("/") ? text.split("/").filter(Boolean).pop() : text.split(":").pop();
  if (segment && /^[A-Za-z0-9._:-]{1,80}$/.test(segment)) return segment;
  return fallback;
}

function linksOf(entry) {
  const links = [];
  for (const child of childElements(entry)) {
    if (localName(child.name) !== "link") continue;
    links.push({
      rel: (child.attrs.rel || "").trim().toLowerCase(),
      href: (child.attrs.href || "").trim(),
    });
  }
  return links;
}

function entryIdOf(entry) {
  return childText(entry, "id");
}

function markPii(el, state) {
  const name = localName(el.name);
  if (PII_TYPES.has(name) || PII_FIELDS.has(name.toLowerCase())) state.stripped = true;
  for (const child of childElements(el)) markPii(child, state);
}

function readingTypeFrom(el) {
  return {
    uom: integerText(childText(el, "uom")),
    powerOfTenMultiplier: integerText(childText(el, "powerOfTenMultiplier")),
    intervalLength: integerText(childText(el, "intervalLength")),
    flowDirection: integerText(childText(el, "flowDirection")),
    currency: integerText(childText(el, "currency")),
    kind: integerText(childText(el, "kind")),
  };
}

function intervalBlockFrom(el) {
  const interval = firstChild(el, "interval");
  const readings = [];
  for (const child of childElements(el)) {
    if (localName(child.name) !== "IntervalReading") continue;
    const period = firstChild(child, "timePeriod");
    const startText = period ? childText(period, "start") : childText(child, "start");
    const durationText = period ? childText(period, "duration") : childText(child, "duration");
    const costText = childText(child, "cost");
    readings.push({
      start: integerText(startText),
      duration: integerText(durationText),
      value: integerText(childText(child, "value")),
      cost: costText === "" ? null : integerText(costText),
    });
  }
  return {
    start: interval ? integerText(childText(interval, "start")) : null,
    duration: interval ? integerText(childText(interval, "duration")) : null,
    readings,
  };
}

function localTimeFrom(el) {
  return {
    tzOffset: integerText(childText(el, "tzOffset")),
    dstOffset: integerText(childText(el, "dstOffset")),
    dstStartRule: childText(el, "dstStartRule") || null,
    dstEndRule: childText(el, "dstEndRule") || null,
  };
}

function summaryMeasurement(el) {
  if (!el) return null;
  const value = integerText(childText(el, "value"));
  if (value == null) return null;
  return {
    value,
    uom: integerText(childText(el, "uom")),
    powerOfTenMultiplier: integerText(childText(el, "powerOfTenMultiplier")),
  };
}

function usageSummaryFrom(el) {
  const period = firstChild(el, "billingPeriod");
  const consumption =
    summaryMeasurement(firstChild(el, "overallConsumptionLastPeriod")) ||
    summaryMeasurement(firstChild(el, "currentBillingPeriodOverAllConsumption"));
  const currencyText = childText(el, "currency");
  const billText = childText(el, "billLastPeriod");
  return {
    start: period ? integerText(childText(period, "start")) : null,
    duration: period ? integerText(childText(period, "duration")) : null,
    billLastPeriod: billText === "" ? null : integerText(billText),
    currency: currencyText === "" ? null : integerText(currencyText),
    consumption,
  };
}

function usagePointFrom(el) {
  const category = firstChild(el, "ServiceCategory");
  const kindText = category ? childText(category, "kind") : childText(el, "kind");
  return { kindText };
}

function extractResource(el) {
  const type = localName(el.name);
  const data = { type };
  if (type === "UsagePoint") data.usagePoint = usagePointFrom(el);
  else if (type === "ReadingType") data.readingType = readingTypeFrom(el);
  else if (type === "IntervalBlock") data.intervalBlock = intervalBlockFrom(el);
  else if (type === "LocalTimeParameters") data.localTime = localTimeFrom(el);
  else if (type === "UsageSummary" || type === "ElectricPowerUsageSummary") data.summary = usageSummaryFrom(el);
  else if (type === "MeterReading") data.meterReading = true;
  return data;
}

function flattenResources(el, state, out, parent) {
  const type = localName(el.name);
  if (PII_TYPES.has(type)) {
    state.stripped = true;
    markPii(el, state);
    return;
  }
  if (RESOURCE_NAMES.has(type)) {
    const rec = extractResource(el);
    rec.nestedUnder = parent || null;
    markPii(el, state);
    out.push(rec);
    for (const child of childElements(el)) flattenResources(child, state, out, rec);
    return;
  }
  for (const child of childElements(el)) flattenResources(child, state, out, parent || null);
}

function collectEntries(root) {
  const name = localName(root.name);
  if (name === "entry") return [root];
  if (name === "feed") {
    return childElements(root).filter((child) => localName(child.name) === "entry");
  }
  const nested = childElements(root).filter((child) => localName(child.name) === "entry");
  if (nested.length) return nested;
  return [{ name: "entry", attrs: {}, children: [root], synthetic: true }];
}

function recordsFromDocument(root, state) {
  const entries = collectEntries(root);
  const records = [];
  let order = 0;
  entries.forEach((entry, entryIndex) => {
    const links = entry.synthetic ? [] : linksOf(entry);
    const entryId = entry.synthetic ? "" : entryIdOf(entry);
    const self = links.find((link) => link.rel === "self");
    const up = links.find((link) => link.rel === "up");
    const related = links.filter((link) => link.rel === "related").map((link) => link.href);
    const found = [];
    const content = entry.synthetic ? null : firstChild(entry, "content");
    const scopeChildren = content ? childElements(content) : childElements(entry);
    for (const child of scopeChildren) flattenResources(child, state, found, null);
    if (!found.length) return;
    found.forEach((rec, offset) => {
      rec.entryIndex = entryIndex;
      rec.order = order;
      order += 1;
      rec.entryId = entryId;
      rec.self = rec.self || "";
      rec.up = rec.up || "";
      rec.related = rec.related || [];
      if (offset === 0) {
        rec.self = self ? self.href : "";
        rec.up = up ? up.href : "";
        rec.related = related;
      }
    });
    records.push(...found);
  });
  return records;
}

function hrefMatches(target, candidate) {
  const a = normHref(target);
  const b = normHref(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.startsWith(a + "/")) return true;
  const aParts = a.split("/").filter(Boolean);
  const bParts = b.split("/").filter(Boolean);
  if (aParts.length >= 1 && bParts.length > aParts.length) {
    const start = bParts.length - aParts.length;
    // Collection hrefs often omit the host path prefix.
    for (let i = 0; i <= bParts.length - aParts.length; i++) {
      let same = true;
      for (let j = 0; j < aParts.length; j++) {
        if (bParts[i + j] !== aParts[j]) {
          same = false;
          break;
        }
      }
      if (same && i + aParts.length < bParts.length) return true;
      if (same && i + aParts.length === bParts.length && a === b) return true;
    }
    if (start > 0) {
      /* checked above */
    }
  }
  return false;
}

function resolveLinks(targetHref, records) {
  if (!targetHref) return [];
  const exact = [];
  const under = [];
  for (const rec of records) {
    if (!rec.self) continue;
    const self = normHref(rec.self);
    const target = normHref(targetHref);
    if (self && self === target) exact.push(rec);
    else if (hrefMatches(targetHref, rec.self)) under.push(rec);
  }
  if (exact.length === 1 && !under.length) return exact;
  if (exact.length && !COLLECTION_NAMES.has(lastSegment(targetHref))) return exact;
  const combined = exact.concat(under.filter((rec) => !exact.includes(rec)));
  return combined.length ? combined : exact;
}

function linkRecords(rec, records) {
  const out = [];
  for (const href of rec.related || []) {
    for (const match of resolveLinks(href, records)) {
      if (!out.includes(match)) out.push(match);
    }
  }
  return out;
}

function parentsOf(rec, records) {
  if (!rec.up) return [];
  return records.filter((other) => other.self && (normHref(other.self) === normHref(rec.up) || hrefMatches(other.self, rec.up) && normHref(other.self) === normHref(rec.up)));
}

function tzModel(localTime) {
  if (!localTime) return null;
  const dstStart = decodeDstRule(localTime.dstStartRule);
  const dstEnd = decodeDstRule(localTime.dstEndRule);
  const disabled = !dstStart || dstStart.disabled || !dstEnd || dstEnd.disabled || !localTime.dstOffset;
  return {
    tzOffset: localTime.tzOffset == null ? 0 : localTime.tzOffset,
    dstOffset: disabled ? 0 : localTime.dstOffset || 0,
    dstStartRule: localTime.dstStartRule || null,
    dstEndRule: localTime.dstEndRule || null,
    dstStart: disabled ? { disabled: true } : dstStart,
    dstEnd: disabled ? { disabled: true } : dstEnd,
  };
}

function publicTz(tz) {
  if (!tz) return null;
  return {
    tzOffset: tz.tzOffset,
    dstOffset: tz.dstOffset,
    dstStartRule: tz.dstStartRule,
    dstEndRule: tz.dstEndRule,
  };
}

function kindFromUnit(unit) {
  if (unit === "kWh" || unit === "W") return "electric";
  if (unit === "therm" || unit === "ft3" || unit === "Btu") return "gas";
  if (unit === "gal" || unit === "m3") return "water";
  return "unknown";
}

function buildDataset(records, state, format) {
  const warnings = [];
  if (state.stripped) {
    warn(
      warnings,
      "stripped-customer-fields",
      "Customer, address, and account elements were dropped and are not in the result."
    );
  }
  if (!records.length) {
    warn(warnings, "no-resources", "No Green Button usage resources were found in the file.");
  }

  const usagePoints = records.filter((rec) => rec.type === "UsagePoint");
  const meters = records.filter((rec) => rec.type === "MeterReading");
  const readingTypes = records.filter((rec) => rec.type === "ReadingType");
  const blocks = records.filter((rec) => rec.type === "IntervalBlock");
  const timeParams = records.filter((rec) => rec.type === "LocalTimeParameters");
  const summaries = records.filter((rec) => rec.type === "UsageSummary" || rec.type === "ElectricPowerUsageSummary");

  let usedFallback = false;

  if (!usagePoints.length) {
    usagePoints.push({
      type: "UsagePoint",
      usagePoint: { kindText: "" },
      self: "",
      up: "",
      related: [],
      entryId: "",
      order: -1,
      synthetic: true,
    });
    usedFallback = true;
    warn(warnings, "synthetic-usage-point", "No UsagePoint entry was found, so one was added for the meters in the file.");
  }

  function ensureMeterList() {
    if (meters.length) return;
    if (!blocks.length && !readingTypes.length) return;
    meters.push({
      type: "MeterReading",
      self: "",
      up: "",
      related: [],
      entryId: "",
      order: blocks.length ? blocks[0].order - 0.5 : 0,
      synthetic: true,
    });
    usedFallback = true;
    warn(warnings, "synthetic-meter", "No MeterReading entry was found, so one was added for the interval blocks.");
  }
  ensureMeterList();

  const meterLinks = new Map();
  for (const meter of meters) {
    const linked = linkRecords(meter, records);
    const nested = records.filter((rec) => rec.nestedUnder === meter);
    const upPointing = meter.self ? records.filter((rec) => rec.up && normHref(rec.up) === normHref(meter.self)) : [];
    meterLinks.set(meter, { linked, nested, upPointing });
  }

  for (const meter of meters) {
    const bag = meterLinks.get(meter);
    meter.readingTypeRecs = uniqueRecs(
      [].concat(bag.linked, bag.nested, bag.upPointing).filter((rec) => rec.type === "ReadingType")
    );
    meter.blockRecs = uniqueRecs(
      [].concat(bag.linked, bag.nested, bag.upPointing).filter((rec) => rec.type === "IntervalBlock")
    );
    meter.usagePointRecs = [];
    const fromUp = parentsOf(meter, usagePoints);
    const fromRelated = linkRecords(meter, records).filter((rec) => rec.type === "UsagePoint");
    const fromNest = meter.nestedUnder && meter.nestedUnder.type === "UsagePoint" ? [meter.nestedUnder] : [];
    meter.usagePointRecs = fromUp.concat(fromRelated, fromNest);
  }

  if (meters.length) {
    const untyped = meters.filter((meter) => meter.readingTypeRecs.length === 0);
    if (untyped.length) {
      const between = assignBetween(meters, readingTypes, "readingTypeRecs");
      if (between) usedFallback = true;
    }
    const unblocked = meters.filter((meter) => meter.blockRecs.length === 0);
    if (unblocked.length) {
      const between = assignBetween(meters, blocks, "blockRecs");
      if (between) usedFallback = true;
    }
    if (meters.every((meter) => meter.readingTypeRecs.length === 0) && readingTypes.length === meters.length) {
      meters.forEach((meter, index) => {
        meter.readingTypeRecs = [readingTypes[index]];
      });
      usedFallback = true;
    }
    if (meters.every((meter) => meter.blockRecs.length === 0) && blocks.length && meters.length === 1) {
      meters[0].blockRecs = blocks.slice();
      usedFallback = true;
    }
  }

  for (const up of usagePoints) {
    const linked = linkRecords(up, records);
    up.meterRecs = uniqueRecs(
      meters.filter(
        (meter) =>
          meter.usagePointRecs.includes(up) ||
          linked.includes(meter) ||
          (meter.up && up.self && normHref(meter.up) === normHref(up.self))
      )
    );
    up.timeRecs = uniqueRecs(
      [].concat(linked, records.filter((rec) => rec.nestedUnder === up)).filter((rec) => rec.type === "LocalTimeParameters")
    );
    up.summaryRecs = uniqueRecs(
      []
        .concat(
          linked,
          records.filter((rec) => rec.nestedUnder === up),
          summaries.filter((rec) => rec.up && up.self && normHref(rec.up) === normHref(up.self))
        )
        .filter((rec) => rec.type === "UsageSummary" || rec.type === "ElectricPowerUsageSummary")
    );
  }

  const unassignedMeters = meters.filter((meter) => meter.usagePointRecs.length === 0 && !usagePoints.some((up) => up.meterRecs.includes(meter)));
  if (unassignedMeters.length && usagePoints.length === 1) {
    for (const meter of unassignedMeters) usagePoints[0].meterRecs.push(meter);
    usedFallback = true;
  } else if (unassignedMeters.length && usagePoints.length === unassignedMeters.length) {
    unassignedMeters.forEach((meter, index) => {
      if (!usagePoints[index].meterRecs.includes(meter)) usagePoints[index].meterRecs.push(meter);
    });
    usedFallback = true;
  }

  if (timeParams.length === 1) {
    for (const up of usagePoints) {
      if (!up.timeRecs.length) {
        up.timeRecs.push(timeParams[0]);
        usedFallback = usagePoints.some((item) => !(item.related || []).length) || usedFallback;
      }
    }
  }
  if (summaries.length && usagePoints.length === 1) {
    for (const summary of summaries) {
      if (!usagePoints[0].summaryRecs.includes(summary)) {
        usagePoints[0].summaryRecs.push(summary);
        if (!summary.up && !(usagePoints[0].related || []).some((href) => hrefMatches(href, summary.self))) usedFallback = true;
      }
    }
  }

  if (usedFallback) {
    warn(
      warnings,
      "unlinked-entries",
      "Some entries had missing related or up links. They were matched by nesting or document order."
    );
  }

  const meterModels = [];
  const readings = [];
  const usagePointModels = [];
  const billPeriods = [];

  usagePoints.forEach((up, upIndex) => {
    const upId = safeId(up.self || up.entryId, "usage-point-" + (upIndex + 1));
    const tz = tzModel(up.timeRecs[0] ? up.timeRecs[0].localTime : null);
    let kind = serviceKindName(up.usagePoint && up.usagePoint.kindText);
    const meterIds = [];
    const pointMeters = up.meterRecs.length ? up.meterRecs : meters.filter(() => usagePoints.length === 1);

    pointMeters.forEach((meter, meterIndex) => {
      const meterId = safeId(meter.self || meter.entryId, upId + "-meter-" + (meterIndex + 1));
      const rt = meter.readingTypeRecs[0] ? meter.readingTypeRecs[0].readingType : null;
      if (meter.readingTypeRecs.length > 1) {
        warn(warnings, "multiple-reading-types", "Meter " + meterId + " has more than one ReadingType. The first one is used.");
      }
      let unit = "kWh";
      let intervalSec = 3600;
      let direction = "unknown";
      let currency = null;
      let quantityKnown = false;
      if (!rt) {
        warn(
          warnings,
          "assumed-reading-type",
          "Meter " + meterId + " has no ReadingType. Values are treated as watt-hours with a multiplier of 0."
        );
      } else {
        intervalSec = rt.intervalLength || intervalSec;
        direction = flowDirectionName(rt.flowDirection);
        currency = currencyName(rt.currency);
      }
      const sample = firstReadingValue(meter);
      if (rt && sample) {
        const normalized = normalizeQuantity(rt.uom, rt.powerOfTenMultiplier, sample.value);
        if (normalized) {
          unit = normalized.unit;
          quantityKnown = normalized.known;
          if (!normalized.known) {
            warn(warnings, "unknown-uom", "Meter " + meterId + " uses uom " + rt.uom + ", which is not converted to kWh, therm, or gal.");
          }
        }
      } else if (rt) {
        const normalized = normalizeQuantity(rt.uom, rt.powerOfTenMultiplier, 0);
        if (normalized) {
          unit = normalized.unit;
          quantityKnown = normalized.known;
        }
      }
      if (!kind) kind = kindFromUnit(unit);
      meterIds.push(meterId);
      meterModels.push({
        id: meterId,
        usagePointId: upId,
        kind: kind || "unknown",
        unit,
        intervalSec,
        tz: publicTz(tz),
        direction,
        currency,
      });

      for (const blockRec of meter.blockRecs) {
        const block = blockRec.intervalBlock;
        for (const reading of block.readings) {
          if (reading.value == null) {
            warn(warnings, "skipped-reading", "An interval reading without a value was skipped.");
            continue;
          }
          let start = reading.start;
          let duration = reading.duration;
          if (start == null) start = block.start;
          if (duration == null) duration = rt && rt.intervalLength ? rt.intervalLength : block.duration;
          if (start == null || duration == null || duration <= 0) {
            warn(warnings, "skipped-reading", "An interval reading without a start or duration was skipped.");
            continue;
          }
          const normalized = rt
            ? normalizeQuantity(rt.uom, rt.powerOfTenMultiplier, reading.value)
            : normalizeQuantity(72, 0, reading.value);
          if (!normalized) continue;
          const startMs = start * 1000;
          const endMs = (start + duration) * 1000;
          const parts = localParts(startMs, tz || emptyTz());
          const cost = reading.cost == null ? null : costToCurrency(reading.cost);
          readings.push({
            meterId,
            startUtc: isoUtc(startMs),
            endUtc: isoUtc(endMs),
            localHour: parts.hour,
            localDate: localDateString(parts),
            value: normalized.value,
            direction,
            cost,
            currency: cost == null ? null : currency,
            _startMs: startMs,
            _weekday: parts.weekday,
          });
          if (reading.cost == null) {
            /* absence is normal */
          }
          if (!quantityKnown && rt && !normalized.known) quantityKnown = false;
        }
      }
    });

    if (!kind) kind = "unknown";
    usagePointModels.push({
      id: upId,
      kind,
      serviceCategory: serviceKindCode(up.usagePoint && up.usagePoint.kindText),
      meterIds,
      tz: publicTz(tz),
    });

    for (const summaryRec of up.summaryRecs) {
      const summary = summaryRec.summary;
      if (!summary || summary.start == null || summary.duration == null) {
        warn(warnings, "skipped-summary", "A UsageSummary without a billing period was skipped.");
        continue;
      }
      let consumption = null;
      let unit = null;
      if (summary.consumption) {
        const normalized = normalizeQuantity(
          summary.consumption.uom,
          summary.consumption.powerOfTenMultiplier,
          summary.consumption.value
        );
        if (normalized) {
          consumption = normalized.value;
          unit = normalized.unit;
        }
      }
      const cost = summary.billLastPeriod == null ? null : costToCurrency(summary.billLastPeriod);
      billPeriods.push({
        usagePointId: upId,
        startUtc: isoUtc(summary.start * 1000),
        endUtc: isoUtc((summary.start + summary.duration) * 1000),
        consumption,
        unit,
        cost,
        currency: currencyName(summary.currency),
      });
    }
  });

  readings.sort((a, b) => a._startMs - b._startMs || (a.meterId < b.meterId ? -1 : 1));
  if (!readings.length && !billPeriods.length) {
    warn(warnings, "no-interval-readings", "The file did not contain interval readings or bill periods.");
  }
  if (readings.length && readings.some((reading) => reading.cost == null) && readings.some((reading) => reading.cost != null)) {
    warn(warnings, "partial-file-cost", "Some interval readings have a cost and some do not.");
  }
  if (meterModels.some((meter) => !meter.tz)) {
    warn(warnings, "no-timezone", "No LocalTimeParameters were found. localHour is the UTC hour.");
  }

  const publicReadings = readings.map((reading) => ({
    meterId: reading.meterId,
    startUtc: reading.startUtc,
    endUtc: reading.endUtc,
    localHour: reading.localHour,
    localDate: reading.localDate,
    value: reading.value,
    direction: reading.direction,
    cost: reading.cost,
    currency: reading.currency,
  }));

  return {
    format,
    warnings,
    strippedCustomerFields: Boolean(state.stripped),
    usagePoints: usagePointModels,
    meters: meterModels,
    readings: publicReadings,
    billPeriods,
    _internal: readings,
  };
}

function uniqueRecs(list) {
  const out = [];
  for (const rec of list) {
    if (!out.includes(rec)) out.push(rec);
  }
  return out;
}

function firstReadingValue(meter) {
  for (const blockRec of meter.blockRecs || []) {
    for (const reading of blockRec.intervalBlock.readings) {
      if (reading.value != null) return reading;
    }
  }
  return null;
}

function assignBetween(meters, items, field) {
  if (!items.length) return false;
  const ordered = meters.slice().sort((a, b) => a.order - b.order);
  let assigned = false;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i][field].length) continue;
    const start = ordered[i].order;
    const end = i + 1 < ordered.length ? ordered[i + 1].order : Infinity;
    const mine = items.filter((item) => item.order > start && item.order < end && !taken(meters, field, item));
    if (mine.length) {
      ordered[i][field] = mine;
      assigned = true;
    }
  }
  return assigned;
}

function taken(meters, field, item) {
  return meters.some((meter) => meter[field] && meter[field].includes(item));
}

function parseEspi(xml) {
  let root;
  try {
    root = parseXml(xml);
  } catch (err) {
    const error = new Error("Could not parse Green Button XML. " + err.message);
    error.code = "parse";
    throw error;
  }
  const state = { stripped: false };
  const records = recordsFromDocument(root, state);
  return finalize(buildDataset(records, state, "espi"));
}

function parseCsv(text) {
  const warnings = [];
  const table = tokenizeCsv(text);
  if (!table.length) {
    const error = new Error("The CSV file is empty.");
    error.code = "parse";
    throw error;
  }
  const headerIndex = table.findIndex((row) => isHeaderRow(row));
  if (headerIndex < 0) {
    const error = new Error(
      "Could not find a usage header row. Expected a date column and a usage column. See the README for the assumed CSV format."
    );
    error.code = "parse";
    throw error;
  }
  const columns = table[headerIndex].map(classifyHeader);
  const rows = table.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell).trim() !== ""));
  let stripped = false;
  for (let i = 0; i < headerIndex; i++) {
    const blob = table[i].join(" ").toLowerCase();
    if (/\b(name|address|account)\b/.test(blob)) stripped = true;
  }
  if (columns.some((column) => column.role === "ignore")) stripped = true;
  if (stripped) {
    warn(warnings, "stripped-customer-fields", "Customer, address, and account columns were dropped and are not in the result.");
  }

  const groups = new Map();
  let skipped = 0;
  let naiveTime = false;
  for (const row of rows) {
    const record = rowObject(columns, row);
    if (!record.date) {
      skipped += 1;
      continue;
    }
    const parsed = buildCsvReading(record);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    if (parsed.naiveTime) naiveTime = true;
    const key = parsed.meterId + "|" + parsed.kind + "|" + parsed.unit;
    if (!groups.has(key)) {
      groups.set(key, {
        meterId: parsed.meterId,
        kind: parsed.kind,
        unit: parsed.unit,
        directions: new Set(),
        intervalSec: [],
        tz: parsed.tz,
        readings: [],
      });
    }
    const group = groups.get(key);
    group.directions.add(parsed.reading.direction);
    group.intervalSec.push(parsed.intervalSec);
    group.readings.push(parsed.reading);
  }
  if (skipped) {
    warn(warnings, "skipped-csv-rows", skipped + " CSV row(s) were skipped because the date or usage was missing.");
  }
  if (naiveTime) {
    warn(
      warnings,
      "csv-naive-time",
      "No utc_offset column was found. Clock times are stored as UTC and localHour is the hour written in the file."
    );
  }
  if (!groups.size) {
    warn(warnings, "no-interval-readings", "The CSV file did not contain any usage rows.");
  }

  const meters = [];
  const readings = [];
  const usagePoints = [];
  let index = 0;
  for (const group of groups.values()) {
    index += 1;
    const intervalSec = median(group.intervalSec) || 3600;
    const direction = group.directions.size === 1 ? [...group.directions][0] : "mixed";
    const meterId = group.meterId || "csv-meter-" + index;
    const usagePointId = "csv-" + meterId;
    meters.push({
      id: meterId,
      usagePointId,
      kind: group.kind,
      unit: group.unit,
      intervalSec,
      tz: publicTz(group.tz),
      direction,
      currency: group.readings.some((reading) => reading.public.cost != null) ? "USD" : null,
    });
    usagePoints.push({
      id: usagePointId,
      kind: group.kind,
      serviceCategory: serviceKindCode(group.kind),
      meterIds: [meterId],
      tz: publicTz(group.tz),
    });
    for (const reading of group.readings) {
      readings.push(Object.assign({ meterId }, reading.public));
    }
  }
  readings.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0));
  const internal = readings.map((reading) => {
    const startMs = Date.parse(reading.startUtc);
    const parts = localParts(startMs, emptyTz());
    return Object.assign({}, reading, { _startMs: startMs, _weekday: parts.weekday });
  });
  // Recompute weekday from the reading's own offset by parsing localDate.
  for (let i = 0; i < readings.length; i++) {
    const [year, month, day] = readings[i].localDate.split("-").map(Number);
    internal[i]._weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    internal[i]._startMs = Date.parse(readings[i].startUtc);
  }
  return finalize({
    format: "csv",
    warnings,
    strippedCustomerFields: stripped,
    usagePoints,
    meters,
    readings,
    billPeriods: [],
    _internal: internal,
  });
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function rowObject(columns, row) {
  const record = {
    date: "",
    endDate: "",
    startTime: "",
    endTime: "",
    usage: null,
    unit: "",
    units: "",
    cost: null,
    type: "",
    notes: "",
    direction: "",
    meter: "",
    duration: null,
    utcOffset: null,
    hasOffset: false,
  };
  columns.forEach((column, index) => {
    const cell = row[index] == null ? "" : String(row[index]).trim();
    if (!column || column.role === "ignore" || column.role === "unknown") return;
    if (column.role === "date") record.date = cell;
    else if (column.role === "endDate") record.endDate = cell;
    else if (column.role === "startTime") record.startTime = cell;
    else if (column.role === "endTime") record.endTime = cell;
    else if (column.role === "usage") {
      record.usage = cell;
      if (column.unit) record.unit = column.unit;
      if (column.direction) record.direction = record.direction || column.direction;
    } else if (column.role === "units") record.units = cell;
    else if (column.role === "cost") record.cost = cell;
    else if (column.role === "type") record.type = cell;
    else if (column.role === "notes") record.notes = cell;
    else if (column.role === "direction") record.direction = cell;
    else if (column.role === "meter") record.meter = cell;
    else if (column.role === "duration") record.duration = cell;
    else if (column.role === "utcOffset") {
      record.utcOffset = cell;
      record.hasOffset = cell !== "";
    }
  });
  return record;
}

function buildCsvReading(record) {
  const date = parseDate(record.date);
  if (!date) return null;
  const usage = parseCsvNumber(record.usage);
  if (usage == null) return null;
  const unitInfo = unitFromCsv(record.unit || record.units || record.usageHeader || "");
  let direction = flowDirectionName(record.direction);
  const notes = (record.notes || "").toLowerCase();
  if (direction === "unknown" && /export|generat|solar|received/.test(notes)) direction = "received";
  let value = usage;
  if (value < 0 && direction === "unknown") {
    direction = "received";
    value = Math.abs(value);
  } else if (value < 0 && direction === "received") {
    value = Math.abs(value);
  }
  if (unitInfo.divisor !== 1) value = round6(value / unitInfo.divisor);
  else value = round6(value);
  const kind = serviceKindName(record.type) || kindFromUnit(unitInfo.unit);
  const offset = record.hasOffset ? parseOffset(record.utcOffset) : null;
  const naiveTime = offset == null;
  const tz = offset == null ? emptyTz() : { tzOffset: offset, dstOffset: 0, dstStart: { disabled: true }, dstEnd: { disabled: true }, dstStartRule: null, dstEndRule: null };
  const startClock = parseClock(record.startTime);
  const endClock = parseClock(record.endTime);
  const endDate = record.endDate ? parseDate(record.endDate) : null;
  let startParts;
  let endParts;
  if (!startClock) {
    startParts = { year: date.year, month: date.month, day: date.day, hour: 0, minute: 0, second: 0 };
    endParts = addDays(startParts, 1);
  } else {
    startParts = Object.assign({ year: date.year, month: date.month, day: date.day }, startClock);
    if (endClock) {
      const base = endDate || date;
      endParts = Object.assign({ year: base.year, month: base.month, day: base.day }, endClock);
      const startMsGuess = wall(startParts, tz);
      let endMsGuess = wall(endParts, tz);
      if (endMsGuess <= startMsGuess) {
        endParts = addDays(endParts, 1);
        endMsGuess = wall(endParts, tz);
      }
    } else if (record.duration) {
      const seconds = Number(record.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      const startMs = wall(startParts, tz);
      const endMs = startMs + seconds * 1000;
      const parts = localParts(endMs, tz);
      endParts = parts;
      const startMsFinal = startMs;
      return finishCsv(record, kind, unitInfo, direction, value, startMsFinal, endMs, tz, naiveTime);
    } else {
      endParts = addHours(startParts, 1);
    }
  }
  const startMs = wall(startParts, tz);
  const endMs = wall(endParts, tz);
  return finishCsv(record, kind, unitInfo, direction, value, startMs, endMs, tz, naiveTime);
}

function finishCsv(record, kind, unitInfo, direction, value, startMs, endMs, tz, naiveTime) {
  const parts = localParts(startMs, tz);
  const cost = record.cost == null || record.cost === "" ? null : parseCsvNumber(record.cost);
  const reading = {
    direction: direction === "unknown" ? "delivered" : direction,
    public: {
      startUtc: isoUtc(startMs),
      endUtc: isoUtc(endMs),
      localHour: parts.hour,
      localDate: localDateString(parts),
      value,
      direction: direction === "unknown" ? "delivered" : direction,
      cost: cost == null ? null : round6(cost),
      currency: cost == null ? null : "USD",
    },
  };
  return {
    meterId: safeId(record.meter, ""),
    kind: kind || "unknown",
    unit: unitInfo.unit,
    intervalSec: Math.round((endMs - startMs) / 1000),
    tz,
    naiveTime,
    reading,
  };
}

function wall(parts, tz) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0) - (tz.tzOffset || 0) * 1000;
}

function addDays(parts, days) {
  const ms = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour || 0, parts.minute || 0, parts.second || 0);
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function addHours(parts, hours) {
  return addDays(Object.assign({}, parts, { hour: (parts.hour || 0) + hours }), 0);
}

function parseDate(text) {
  const value = String(text).trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (match) return { year: Number(match[3]), month: Number(match[1]), day: Number(match[2]) };
  return null;
}

function parseClock(text) {
  if (!text) return null;
  const value = String(text).trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] ? Number(match[3]) : 0;
  const ampm = match[4] ? match[4].toLowerCase() : "";
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function parseOffset(text) {
  const value = String(text).trim();
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    if (Math.abs(n) <= 18) return n * 3600;
    return n;
  }
  const match = /^([+-])(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 3600 + Number(match[3]) * 60);
}

function parseCsvNumber(text) {
  if (text == null) return null;
  let value = String(text).trim();
  if (!value) return null;
  value = value.replace(/[$,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unitFromCsv(text) {
  const value = String(text).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value === "wh") return { unit: "kWh", divisor: 1000 };
  if (value === "kwh" || value === "kilowatthour" || value === "kilowatthours") return { unit: "kWh", divisor: 1 };
  if (value === "therm" || value === "therms") return { unit: "therm", divisor: 1 };
  if (value === "gal" || value === "gallon" || value === "gallons") return { unit: "gal", divisor: 1 };
  if (value === "ccf") return { unit: "ccf", divisor: 1 };
  if (value === "ft3" || value === "cf") return { unit: "ft3", divisor: 1 };
  if (!value) return { unit: "kWh", divisor: 1 };
  return { unit: value, divisor: 1 };
}

function normalizeHeader(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[_/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyHeader(text) {
  const n = normalizeHeader(text);
  if (!n) return { role: "unknown" };
  if (["name", "customer name", "address", "service address", "billing address", "account", "account number", "email", "phone"].includes(n)) {
    return { role: "ignore" };
  }
  if (["date", "start date", "usage date", "day", "read date"].includes(n)) return { role: "date" };
  if (n === "end date") return { role: "endDate" };
  if (["start time", "start", "time", "from"].includes(n)) return { role: "startTime" };
  if (["end time", "end", "to"].includes(n)) return { role: "endTime" };
  if (["units", "unit", "uom"].includes(n)) return { role: "units" };
  if (["cost", "cost usd", "charge", "charges", "amount"].includes(n)) return { role: "cost" };
  if (["type", "commodity", "service", "fuel"].includes(n)) return { role: "type" };
  if (["notes", "note", "description"].includes(n)) return { role: "notes" };
  if (["direction", "flow", "channel"].includes(n)) return { role: "direction" };
  if (["meter", "meter number", "meter id", "usage point", "usage point id"].includes(n)) return { role: "meter" };
  if (["duration", "interval", "interval seconds"].includes(n)) return { role: "duration" };
  if (["utc offset", "tz offset", "timezone offset", "utc offset seconds"].includes(n)) return { role: "utcOffset" };
  if (["usage kwh", "consumption kwh", "kwh"].includes(n)) return { role: "usage", unit: "kWh" };
  if (["usage wh", "wh"].includes(n)) return { role: "usage", unit: "Wh" };
  if (["usage therms", "usage therm", "therms", "therm"].includes(n)) return { role: "usage", unit: "therm" };
  if (["usage gallons", "gallons", "gallon", "gal"].includes(n)) return { role: "usage", unit: "gal" };
  if (["generation", "export", "received", "generation kwh"].includes(n)) return { role: "usage", unit: n.includes("kwh") ? "kWh" : "", direction: "received" };
  if (["usage", "consumption", "value", "net"].includes(n)) return { role: "usage", direction: n === "net" ? "net" : "" };
  return { role: "unknown" };
}

function isHeaderRow(row) {
  const roles = row.map(classifyHeader);
  return roles.some((column) => column.role === "date") && roles.some((column) => column.role === "usage");
}

function tokenizeCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quote = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quote = false;
      } else cell += c;
      continue;
    }
    if (c === '"') {
      quote = true;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((item) => item.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((item) => item.trim() !== "")) rows.push(row);
  }
  return rows;
}

function dateRangeOf(readings) {
  if (!readings.length) return null;
  let start = readings[0].startUtc;
  let end = readings[0].endUtc;
  for (const reading of readings) {
    if (reading.startUtc < start) start = reading.startUtc;
    if (reading.endUtc > end) end = reading.endUtc;
  }
  return { startUtc: start, endUtc: end };
}

function finalize(dataset) {
  const units = [];
  for (const meter of dataset.meters) {
    if (!units.includes(meter.unit)) units.push(meter.unit);
  }
  return {
    format: dataset.format,
    warnings: dataset.warnings,
    strippedCustomerFields: dataset.strippedCustomerFields,
    usagePoints: dataset.usagePoints,
    meters: dataset.meters,
    readings: dataset.readings,
    billPeriods: dataset.billPeriods,
    dateRange: dateRangeOf(dataset.readings),
    units,
    _internal: dataset._internal,
  };
}

function parseContent(text, formatHint) {
  const trimmed = String(text).replace(/^\uFEFF/, "");
  if (trimmed.charCodeAt(0) === 0x50 && trimmed.charCodeAt(1) === 0x4b) {
    const error = new Error("This file is a zip archive. Unzip it and pass the XML or CSV inside. This plugin does not read zip files.");
    error.code = "parse";
    throw error;
  }
  const hint = (formatHint || "").toLowerCase();
  const head = trimmed.trimStart();
  if (hint === "csv" || (!head.startsWith("<") && hint !== "espi" && hint !== "xml")) return parseCsv(trimmed);
  return parseEspi(trimmed);
}

module.exports = {
  parseEspi,
  parseCsv,
  parseContent,
  classifyHeader,
  normalizeHeader,
};
