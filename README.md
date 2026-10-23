# Green Button usage

A local Cursor plugin that reads a Green Button file you already downloaded and summarizes electric, gas, or water use on your machine, with no login and no network calls.

Version 0.1 reads a file from disk. It does not use OAuth, Green Button Connect, or Share My Data.

## Install

Node.js 18 or newer. There is no `package.json` and nothing to install with npm. The server is a zero-dependency Node process and speaks MCP over stdio.

```bash
git clone https://github.com/tnvolman/green-button-usage
cd green-button-usage
node scripts/prove.js
```

`node scripts/prove.js` runs the `node --test` suite. The server is `server/greenbutton-mcp.js`.

Cursor loads this directory as an Agent Plugin. [`plugin.json`](plugin.json) is the manifest (`green-button` 0.1.0). [`mcp.json`](mcp.json) starts the server with `node` over stdio:

```json
{
  "mcpServers": {
    "green-button": {
      "type": "stdio",
      "command": "node",
      "args": ["${CURSOR_PLUGIN_ROOT}/server/greenbutton-mcp.js"],
      "cwd": "${CURSOR_PLUGIN_ROOT}"
    }
  }
}
```

To attach the same server by hand:

```json
{
  "mcpServers": {
    "green-button": {
      "command": "node",
      "args": ["/absolute/path/to/green-button-usage/server/greenbutton-mcp.js"]
    }
  }
}
```

Download the Green Button file from your utility yourself (often labeled Download My Data). Unzip a `.zip` first. This plugin never logs in and never fetches the file.

## Example

Question, asked of the synthetic fixture `samples/electric-hourly.xml` (not a customer's data): how did delivered electricity in July 2024 compare with January 2024?

`load_greenbutton` with that path returns file id `gb_35b2fc67d5be`, meter `DELIVERED` (electric, kWh, delivered, 9528 readings) and meter `RECEIVED` (electric, kWh, received, 3970 readings). `dateRange` is `2024-01-01T08:00:00Z` through `2025-02-01T08:00:00Z`.

`compare_periods` with `meterId` `DELIVERED`, `mode` `ranges`, period A `2024-07-01` to `2024-07-31`, and period B `2024-01-01` to `2024-01-31` returns:

```json
{
  "fileId": "gb_35b2fc67d5be",
  "meterId": "DELIVERED",
  "mode": "ranges",
  "direction": "delivered",
  "note": null,
  "unit": "kWh",
  "periodA": {
    "label": "2024-07-01..2024-07-31",
    "startLocal": "2024-07-01",
    "endLocal": "2024-07-31",
    "startUtc": "2024-07-01T07:00:00Z",
    "endUtc": "2024-08-01T07:00:00Z",
    "days": 31,
    "daysWithData": 31,
    "total": 437.658,
    "perDay": 14.118,
    "intervalCount": 744
  },
  "periodB": {
    "label": "2024-01-01..2024-01-31",
    "startLocal": "2024-01-01",
    "endLocal": "2024-01-31",
    "startUtc": "2024-01-01T08:00:00Z",
    "endUtc": "2024-02-01T08:00:00Z",
    "days": 31,
    "daysWithData": 31,
    "total": 313.658,
    "perDay": 10.118,
    "intervalCount": 744
  },
  "delta": {
    "total": 124,
    "perDay": 4,
    "percentTotal": 39.533505,
    "percentPerDay": 39.533505
  },
  "normalization": "perDay divides the period total by the number of local calendar days in the window, so months of different lengths can be compared.",
  "privacy": "In memory for this session only. Customer, address, and account fields are not included. A meter ID with 6 or more digits is returned as **** plus its last 4 characters."
}
```

July's `startUtc` is `07:00Z` and January's is `08:00Z` because this fixture's `LocalTimeParameters` are Pacific time with daylight saving.

## Tools

| Tool | Result |
| --- | --- |
| `load_greenbutton` | File id, meters, date range, units. Pass `path`, or `xml_text`, or `csv_text`. |
| `list_usage_points` | Usage points and their meters. |
| `usage_summary` | Day, week, or month totals, plus avg, min, and max of those bucket totals. |
| `peak_hours` | Top intervals, average by local hour, weekday vs weekend, baseload, load factor. |
| `compare_periods` | `mom`, `yoy`, or two ranges. `perDay` divides by the calendar days in the window. |
| `estimate_cost` | File costs when the file has them, or a flat, time-of-use, or tier rate, plus a fixed monthly charge. Always labeled an estimate. |
| `export_normalized` | CSV or JSON at a path you choose. The only disk write. |

Service category `0` is electric, `1` is gas, and `2` is water. Flow direction `1` is delivered and `19` is received, so solar export stays off the consumption total unless you pass `direction: "net"`. `server/units.js` also names the other ESPI service-kind and flow-direction codes it recognizes.

`skills/green-button/SKILL.md` is the short instruction sheet for the agent.

## CSV format this version assumes

ESPI XML is the Green Button feed. The CSV reader is a fallback for one column layout, not a promise that every utility layout will parse.

- Rows before the header are ignored. A header is the first row that has both a date column and a usage column.
- Delimiter is comma. Quoted fields are allowed.
- Date columns: `Date`, `Start Date`, `Usage Date`, `Day`. `MM/DD/YYYY` or `YYYY-MM-DD`.
- Time columns: `Start Time`, `End Time`. `HH:MM` or `h:mm AM/PM`. An end time that is not after the start rolls to the next day.
- Usage columns: `Usage`, `Consumption`, `Usage (kWh)`, `kWh`, `therms`, `gallons`, `Generation`, `Export`. A unit in the header or in a `Units` column is used. `Wh` is divided by 1000. Values are the numbers written in the file, not ESPI integers.
- `Cost` is dollars as written (a `$` and commas are allowed). It is not scaled by 10^-5 the way ESPI `cost` is.
- `Direction`, or a note that says export / generation / solar, marks received energy. A negative usage with no direction is treated as received and stored as a positive value.
- `Meter` becomes the meter id. `Type` of Electric, Gas, or Water sets the kind.
- `utc_offset` may be seconds (`-28800`) or `±HH:MM`. Without it, the clock times are stored as UTC and `localHour` is the hour in the file. The load result warns with `csv-naive-time`.
- Name, address, and account columns are not copied into the result.

`samples/usage-export.csv` is a synthetic file in this shape.

## Samples

All three samples are synthetic. They are not a customer's data. Rebuild them with `node scripts/build-samples.js`.

| File | Contents |
| --- | --- |
| `samples/electric-hourly.xml` | One electric usage point, hourly, 1 Jan 2024 through 31 Jan 2025, Pacific Time with DST, delivered and received (solar) channels, monthly usage summaries. |
| `samples/gas-daily.xml` | Gas, daily therms for 2024, no Atom links, so the parser has to use document order. |
| `samples/usage-export.csv` | A short electric CSV with a fake preamble, a `utc_offset` column, and a few export rows. |

## How values are scaled

- Interval `value` is an integer. The quantity is `value * 10^powerOfTenMultiplier` in the ReadingType unit. `uom` 72 (Wh) is then divided by 1000 to kWh. `169` is therms. `128` is US gallons.
- `cost` and `billLastPeriod` use Green Button's fixed scale of 10^-5 of the currency unit. `100000` is 1.00 in the ReadingType currency (`840` is USD). The multiplier on the ReadingType does not scale the cost. `server/units.js` cites [greenbuttonalliance.org/costandcurrency](https://www.greenbuttonalliance.org/costandcurrency) for that scale.
- `LocalTimeParameters.tzOffset` is standard time in seconds. DST rules are the 32-bit ESPI bitmap (`360E2000` is the second Sunday in March at 02:00). `FFFFFFFF` turns DST off.

## Limits

- Download-file only. No utility login, OAuth, Green Button Connect, or Share My Data.
- No network calls. An `https` href inside the XML is an identifier, not a request.
- Memory is discarded when the process exits. Nothing is written unless you call `export_normalized`.
- Zip files are rejected. Files larger than 32 MB are rejected.
- The cost tool is an estimate. It does not model demand charges, baseline allowances, net-metering true-up, taxes, or a minimum bill. Tiers reset on calendar months that contain readings, and the fixed monthly charge is added once per such month. Time-of-use windows use the local hour of the interval start; the first matching window wins; `endHour` is exclusive.
- File costs are used when any selected reading has one, unless `useFileCost` is false.
- CSV support is the column map above. A file that does not match it will not parse.
- IANA timezone names are not resolved. Without `LocalTimeParameters`, `localHour` is the UTC hour.
- A meter ID with 6 or more digits is treated as an account number. Every tool result and export shows `****` plus the last 4 characters (`990000001234` becomes `****1234`) and does not include the rest of the ID. Warning text is masked the same way. There is no option to reveal the full ID. A meter ID with fewer than 6 digits, such as `DELIVERED` or `12345`, is returned unchanged. You may pass either the masked ID or the original ID back in; the result still shows the mask. If two meter IDs mask to the same 4 characters, passing that mask is an error and the error does not contain either full ID.
- Usage-point IDs are returned as stored. An account number that appears only in a usage-point ID is still returned. Text that copies a masked meter ID is removed with that meter ID.
- The parser keeps the last path segment of a meter or usage-point id (the part after the last `:` when there is no `/`). If that segment is empty, longer than 80 characters, or contains a character other than letters, digits, and `._:-`, it substitutes `usage-point-N` or `<usage-point-id>-meter-N`. A CSV meter value that fails the same check becomes `csv-meter-N`. The original text is not kept.
- Not every utility quirk is covered. Missing links, a missing namespace prefix, and a single resource (instead of an Atom feed) are accepted. A file that is neither ESPI nor the CSV shape above fails.
- This repository is not submitted to a marketplace.

## Privacy

See [PRIVACY.md](PRIVACY.md). Results stay in memory for the session. Customer, address, and account fields are omitted. There is no telemetry.

## Data sources and licenses

- The code, docs, and sample files in this repository are [MIT](LICENSE), copyright (c) 2026 tnvolman.
- The three files in `samples/` are synthetic output of `scripts/build-samples.js`. The name, street, and account number in them are fake and exist so tests can prove those fields are dropped. They are not a customer's account.
- The server reads an ESPI Atom document (`http://naesb.org/espi`) or the CSV layout above. It does not include or redistribute the NAESB ESPI standard.
- There are no npm dependencies and no third-party runtime libraries.
- This project is not a utility and is not affiliated with the Green Button Alliance, NAESB, PG&E, SCE, Con Edison, or SDG&E.

Built by Michael McClanahan (@TNVOLMAN)
