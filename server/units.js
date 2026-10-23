"use strict";

/**
 * Green Button / NAESB ESPI unit, cost, and local-time math.
 *
 * Quantity values are integers in the XML. The real quantity is
 *   value * 10^powerOfTenMultiplier
 * in the ReadingType unit (uom). Wh (72) is then divided by 1000 to kWh.
 *
 * Cost is a separate fixed scale. Green Button encodes money in
 * hundred-thousandths of the currency unit (10^-5), not with the
 * ReadingType powerOfTenMultiplier. $1.00 is the integer 100000.
 * https://www.greenbuttonalliance.org/costandcurrency
 *
 * DST rules are the 32-bit ESPI bitmap:
 *   bits 28-31 month (1-12)
 *   bits 25-27 operator (0 day-of-month, 1 on-or-after, 2-6 nth weekday, 7 last)
 *   bits 20-24 day of month
 *   bits 17-19 weekday (1 Monday .. 7 Sunday, 0 not applicable)
 *   bits 12-16 hour (0-23)
 *   bits 0-11  seconds after the hour
 * tzOffset is standard time, not daylight time. A rule of FFFFFFFF disables DST.
 */

const COST_DENOMINATOR = 100000;

const SERVICE_KINDS = {
  0: "electric",
  1: "gas",
  2: "water",
  3: "time",
  4: "heat",
  5: "refuse",
  6: "sewerage",
  7: "rates",
  8: "tv",
  9: "internet",
};

const SERVICE_NAMES = {
  electricity: "electric",
  electric: "electric",
  gas: "gas",
  naturalgas: "gas",
  water: "water",
  time: "time",
  heat: "heat",
  refuse: "refuse",
  sewerage: "sewerage",
  rates: "rates",
  tvlicence: "tv",
  tv: "tv",
  internet: "internet",
};

const CURRENCIES = {
  36: "AUD",
  124: "CAD",
  392: "JPY",
  826: "GBP",
  840: "USD",
  978: "EUR",
};

/**
 * uom codes used for home interval data. `divisor` converts the scaled
 * base-unit quantity into the normalized unit named `unit`.
 */
const UOM = {
  72: { symbol: "Wh", unit: "kWh", divisor: 1000 },
  169: { symbol: "therm", unit: "therm", divisor: 1 },
  128: { symbol: "USGal", unit: "gal", divisor: 1 },
  130: { symbol: "ImpGal", unit: "gal", divisor: 1 },
  119: { symbol: "ft3", unit: "ft3", divisor: 1 },
  120: { symbol: "ft3", unit: "ft3", divisor: 1 },
  42: { symbol: "m3", unit: "m3", divisor: 1 },
  132: { symbol: "Btu", unit: "Btu", divisor: 1 },
  38: { symbol: "W", unit: "W", divisor: 1 },
};

const COLLECTION_NAMES = new Set([
  "UsagePoint",
  "MeterReading",
  "IntervalBlock",
  "ReadingType",
  "UsageSummary",
  "ElectricPowerUsageSummary",
  "LocalTimeParameters",
]);

function round6(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

function money(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * COST_DENOMINATOR) / COST_DENOMINATOR;
}

function serviceKindName(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) {
    const code = Number(text);
    return Object.prototype.hasOwnProperty.call(SERVICE_KINDS, code) ? SERVICE_KINDS[code] : null;
  }
  const key = text.toLowerCase().replace(/[^a-z]/g, "");
  return SERVICE_NAMES[key] || null;
}

function serviceKindCode(value) {
  const name = serviceKindName(value);
  if (!name) return null;
  for (const code of Object.keys(SERVICE_KINDS)) {
    if (SERVICE_KINDS[code] === name) return Number(code);
  }
  return null;
}

function flowDirectionName(value) {
  if (value == null || value === "") return "unknown";
  const text = String(value).trim().toLowerCase();
  if (text === "delivered" || text === "forward" || text === "consumption" || text === "import") {
    return "delivered";
  }
  if (
    text === "received" ||
    text === "reverse" ||
    text === "export" ||
    text === "generation" ||
    text === "exported" ||
    text === "solar"
  ) {
    return "received";
  }
  if (text === "net") return "net";
  if (text === "total") return "total";
  if (!/^-?\d+$/.test(text)) return "unknown";
  const code = Number(text);
  if (code === 1 || code === 8) return "delivered";
  if (code === 19 || code === 10) return "received";
  if (code === 4) return "net";
  if (code === 20 || code === 21) return "total";
  if (code === 0) return "unknown";
  return "unknown";
}

function currencyName(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (/^[A-Za-z]{3}$/.test(text)) return text.toUpperCase();
  if (!/^-?\d+$/.test(text)) return null;
  const code = Number(text);
  return CURRENCIES[code] || String(code);
}

function normalizeQuantity(uom, multiplier, value) {
  const raw = Number(value);
  const mult = multiplier == null || multiplier === "" ? 0 : Number(multiplier);
  if (!Number.isFinite(raw) || !Number.isFinite(mult)) return null;
  const base = raw * 10 ** mult;
  const code = Number(uom);
  const known = UOM[code];
  if (!known) {
    return {
      symbol: Number.isFinite(code) ? "uom_" + code : "unknown",
      unit: Number.isFinite(code) ? "uom_" + code : "unknown",
      value: round6(base),
      known: false,
    };
  }
  return {
    symbol: known.symbol,
    unit: known.unit,
    value: round6(base / known.divisor),
    known: true,
  };
}

function costToCurrency(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const sign = n < 0 ? "-" : "";
  const scaled = Math.round(Math.abs(n));
  const whole = Math.trunc(scaled / COST_DENOMINATOR);
  const frac = String(scaled % COST_DENOMINATOR).padStart(5, "0");
  return Number(sign + whole + "." + frac);
}

function decodeDstRule(hex) {
  if (hex == null) return null;
  let text = String(hex).trim().replace(/^0x/i, "");
  if (!text) return null;
  if (!/^[0-9a-fA-F]+$/.test(text)) return null;
  if (text.length > 8) return null;
  text = text.padStart(8, "0");
  const value = parseInt(text, 16);
  if (value === 0xffffffff) {
    return { disabled: true, month: 0, operator: 0, dayOfMonth: 0, dayOfWeek: 0, hour: 0, seconds: 0 };
  }
  return {
    disabled: false,
    month: (value >>> 28) & 0xf,
    operator: (value >>> 25) & 0x7,
    dayOfMonth: (value >>> 20) & 0x1f,
    dayOfWeek: (value >>> 17) & 0x7,
    hour: (value >>> 12) & 0x1f,
    seconds: value & 0xfff,
  };
}

function espiWeekdayToJs(day) {
  if (day === 7) return 0;
  return day;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function transitionLocalDate(rule, year) {
  if (!rule || rule.disabled) return null;
  const month = rule.month;
  if (month < 1 || month > 12) return null;
  const hour = rule.hour;
  const minute = Math.floor(rule.seconds / 60);
  const second = rule.seconds % 60;
  const jsDow = espiWeekdayToJs(rule.dayOfWeek);
  let day = rule.dayOfMonth || 1;
  if (rule.operator === 0) {
    day = rule.dayOfMonth;
  } else if (rule.operator === 1) {
    const start = rule.dayOfMonth || 1;
    const delta = (jsDow - weekdayOf(year, month, start) + 7) % 7;
    day = start + delta;
  } else {
    const matches = [];
    const count = daysInMonth(year, month);
    for (let d = 1; d <= count; d++) {
      if (weekdayOf(year, month, d) === jsDow) matches.push(d);
    }
    if (!matches.length) return null;
    if (rule.operator === 7) day = matches[matches.length - 1];
    else {
      const nth = rule.operator - 1;
      day = matches[nth - 1];
    }
  }
  if (!day) return null;
  return { year, month, day, hour, minute, second };
}

function wallTimeToEpochMs(parts, offsetSeconds) {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - offsetSeconds * 1000;
}

function dstBoundsUtc(tz, year) {
  if (!tz || !tz.dstStart || tz.dstStart.disabled || !tz.dstEnd || tz.dstEnd.disabled) return null;
  const startParts = transitionLocalDate(tz.dstStart, year);
  const endParts = transitionLocalDate(tz.dstEnd, year);
  if (!startParts || !endParts) return null;
  const startUtc = wallTimeToEpochMs(startParts, tz.tzOffset || 0);
  const endUtc = wallTimeToEpochMs(endParts, (tz.tzOffset || 0) + (tz.dstOffset || 0));
  return { startUtc, endUtc };
}

function offsetAt(tz, utcMs) {
  const base = tz && Number.isFinite(tz.tzOffset) ? tz.tzOffset : 0;
  if (!tz || !tz.dstOffset || !tz.dstStart || tz.dstStart.disabled || !tz.dstEnd || tz.dstEnd.disabled) {
    return base;
  }
  const year = new Date(utcMs).getUTCFullYear();
  const wraps = tz.dstStart.month > tz.dstEnd.month;
  for (const y of [year - 1, year, year + 1]) {
    const startParts = transitionLocalDate(tz.dstStart, y);
    const endParts = transitionLocalDate(tz.dstEnd, wraps ? y + 1 : y);
    if (!startParts || !endParts) continue;
    const startUtc = wallTimeToEpochMs(startParts, base);
    const endUtc = wallTimeToEpochMs(endParts, base + tz.dstOffset);
    if (utcMs >= startUtc && utcMs < endUtc) return base + tz.dstOffset;
  }
  return base;
}

function localParts(utcMs, tz) {
  const off = offsetAt(tz, utcMs);
  const local = new Date(utcMs + off * 1000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    weekday: local.getUTCDay(),
    offset: off,
  };
}

function localDateString(parts) {
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  return parts.year + "-" + m + "-" + d;
}

function localWallToUtc(year, month, day, hour, minute, second, tz) {
  const parts = { year, month, day, hour: hour || 0, minute: minute || 0, second: second || 0 };
  let guess = wallTimeToEpochMs(parts, tz && tz.tzOffset ? tz.tzOffset : 0);
  for (let i = 0; i < 4; i++) {
    const off = offsetAt(tz, guess);
    const next = wallTimeToEpochMs(parts, off);
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function emptyTz() {
  return { tzOffset: 0, dstOffset: 0, dstStartRule: null, dstEndRule: null, dstStart: null, dstEnd: null };
}

module.exports = {
  COST_DENOMINATOR,
  COLLECTION_NAMES,
  SERVICE_KINDS,
  UOM,
  round6,
  money,
  serviceKindName,
  serviceKindCode,
  flowDirectionName,
  currencyName,
  normalizeQuantity,
  costToCurrency,
  decodeDstRule,
  transitionLocalDate,
  dstBoundsUtc,
  offsetAt,
  localParts,
  localDateString,
  localWallToUtc,
  isoUtc,
  pad2,
  daysInMonth,
  emptyTz,
};
