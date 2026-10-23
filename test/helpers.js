"use strict";

function feed(inner) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">' +
    inner +
    "</feed>"
  );
}

function entry(id, inner) {
  return "<entry><id>" + id + "</id><content>" + inner + "</content></entry>";
}

function localTime(offset) {
  return entry(
    "urn:synthetic:LocalTimeParameters/LTP",
    "<espi:LocalTimeParameters><espi:dstEndRule>FFFFFFFF</espi:dstEndRule><espi:dstOffset>0</espi:dstOffset>" +
      "<espi:dstStartRule>FFFFFFFF</espi:dstStartRule><espi:tzOffset>" +
      (offset || 0) +
      "</espi:tzOffset></espi:LocalTimeParameters>"
  );
}

function readingType(id, flow, uom, multiplier, interval, currency) {
  return entry(
    "urn:synthetic:ReadingType/" + id,
    "<espi:ReadingType><espi:currency>" +
      (currency == null ? 840 : currency) +
      "</espi:currency><espi:flowDirection>" +
      flow +
      "</espi:flowDirection><espi:intervalLength>" +
      interval +
      "</espi:intervalLength><espi:powerOfTenMultiplier>" +
      multiplier +
      "</espi:powerOfTenMultiplier><espi:uom>" +
      uom +
      "</espi:uom></espi:ReadingType>"
  );
}

function intervalBlock(readings) {
  const body = readings
    .map((reading) => {
      const cost = reading.cost == null ? "" : "<espi:cost>" + reading.cost + "</espi:cost>";
      return (
        "<espi:IntervalReading>" +
        cost +
        "<espi:timePeriod><espi:duration>" +
        reading.duration +
        "</espi:duration><espi:start>" +
        reading.start +
        "</espi:start></espi:timePeriod><espi:value>" +
        reading.value +
        "</espi:value></espi:IntervalReading>"
      );
    })
    .join("");
  return entry(
    "urn:synthetic:IntervalBlock/IB",
    "<espi:IntervalBlock><espi:interval><espi:duration>" +
      readings.length * readings[0].duration +
      "</espi:duration><espi:start>" +
      readings[0].start +
      "</espi:start></espi:interval>" +
      body +
      "</espi:IntervalBlock>"
  );
}

function usagePoint(kind) {
  return entry(
    "urn:synthetic:UsagePoint/UP1",
    "<espi:UsagePoint><espi:ServiceCategory><espi:kind>" + kind + "</espi:kind></espi:ServiceCategory></espi:UsagePoint>"
  );
}

function usagePointWithId(id, kind) {
  return entry(
    "urn:synthetic:UsagePoint/" + id,
    "<espi:UsagePoint><espi:ServiceCategory><espi:kind>" + (kind == null ? 0 : kind) + "</espi:kind></espi:ServiceCategory></espi:UsagePoint>"
  );
}

function longUsagePointFeed(usagePointId) {
  const id = usagePointId || "ACCT-4417220931";
  return feed(
    usagePointWithId(id, 0) +
      localTime(0) +
      meter("HOUSE") +
      readingType("RT", 1, 72, 0, 3600, 840) +
      intervalBlock([{ start: unix("2024-01-15T00:00:00Z"), duration: 3600, value: 1000, cost: 100000 }])
  );
}

function meter(id) {
  return entry("urn:synthetic:MeterReading/" + id, "<espi:MeterReading></espi:MeterReading>");
}

function unix(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

module.exports = {
  feed,
  entry,
  localTime,
  readingType,
  intervalBlock,
  usagePoint,
  usagePointWithId,
  longUsagePointFeed,
  meter,
  unix,
};
