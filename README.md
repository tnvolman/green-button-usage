# Green Button usage (v0.1)

A local Cursor Agent Plugin that reads a Green Button file you downloaded and summarizes home electric, gas, or water use. It is a zero-dependency Node process. It speaks MCP over stdio. It does not log in, and it does not make network calls.

v0.1 is download-file only. There is no OAuth, no Green Button Connect, and no Share My Data.

## Install

Node.js 18 or newer. Nothing to install with npm.

```bash
git clone https://github.com/tnvolman/green-button-usage
cd green-button-usage
node scripts/prove.js
```

`scripts/prove.js` runs the `node --test` suite. The server is `server/greenbutton-mcp.js`.

Cursor loads this repo as an Agent Plugin (`plugin.json` and `mcp.json`). The MCP entry starts the server with `node` over stdio. `mcp.json` uses `${CURSOR_PLUGIN_ROOT}` because Cursor does not expand the Agent Plugins `${PLUGIN_ROOT}` variable (checked against the Cursor plugin reference on 2026-10-23).

To attach it by hand:

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

Then ask the agent to load your file with `load_greenbutton`.

## Download your Green Button file

Sign in on the utility site and download the file yourself. This plugin never does that for you. Links below were fetched on 2026-10-23.

| Utility | Page | Verified |
| --- | --- | --- |
| PG&E | [Energy usage tools](https://www.pge.com/en/save-energy-and-money/energy-usage-and-tips/understand-my-usage.html) | Yes. The page says: sign in, open Usage and rates, View Usage Details, then Green Button Download My Data. |
| SCE | [Energy Management Center](https://www.sce.com/clean-energy-efficiency/home/energy-management-center) | Yes. The page describes Green Button Download on SCE.com for hourly and daily usage. It does not list the clicks inside the account. |
| Con Edison | [Download your energy data](https://www.coned.com/en/save-money/make-better-energychoices-with-green-button) | Yes. The page says Download My Data can return up to one year as CSV or XML. |
| SDG&E | [Download My Green Button Data](https://www.sdge.com/green-button/download-my-green-button-data) | Yes. The page says: My Energy Center, Usage, Electric or Gas, Green Button Download, then date range and format. |

Unzip a `.zip` download first. This version does not open zip files.

## What the tools do

| Tool | Result |
| --- | --- |
| `load_greenbutton` | File id, meters, date range, units. Pass `path`, or `xml_text`, or `csv_text`. |
| `list_usage_points` | Usage points and their meters. |
| `usage_summary` | Day, week, or month totals, plus avg, min, and max of those bucket totals. |
| `peak_hours` | Top intervals, average by local hour, weekday vs weekend, baseload, load factor. |
| `compare_periods` | `mom`, `yoy`, or two ranges. `perDay` divides by the calendar days in the window. |
| `estimate_cost` | File costs when the file has them, or a flat, time-of-use, or tier rate, plus a fixed monthly charge. Always labeled an estimate. |
| `export_normalized` | CSV or JSON at a path you choose. The only disk write. |

Service category `0` is electric, `1` is gas, `2` is water. Flow direction `1` is delivered and `19` is received, so solar export stays off the consumption total unless you pass `direction: "net"`.

## CSV format this version assumes

ESPI XML is the Green Button feed. The CSV reader is a fallback for a Con Edison / PG&E style usage export, not a promise that every utility layout will parse.

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

All three samples are synthetic. They are not a customer's data.

| File | Contents |
| --- | --- |
| `samples/electric-hourly.xml` | One electric usage point, hourly, 1 Jan 2024 through 31 Jan 2025, Pacific Time with DST, delivered and received (solar) channels, monthly usage summaries. |
| `samples/gas-daily.xml` | Gas, daily therms for 2024, no Atom links, so the parser has to use document order. |
| `samples/usage-export.csv` | A short electric CSV with a fake preamble, a `utc_offset` column, and a few export rows. |

Rebuild them with `node scripts/build-samples.js`.

## How values are scaled

- Interval `value` is an integer. The quantity is `value * 10^powerOfTenMultiplier` in the ReadingType unit. `uom` 72 (Wh) is then divided by 1000 to kWh. `169` is therms. `128` is US gallons.
- `cost` and `billLastPeriod` use Green Button's fixed scale of 10^-5 of the currency unit. `100000` is 1.00 in the ReadingType currency (`840` is USD). The multiplier on the ReadingType does not scale the cost.
- `LocalTimeParameters.tzOffset` is standard time in seconds. DST rules are the 32-bit ESPI bitmap (`360E2000` is the second Sunday in March at 02:00). `FFFFFFFF` turns DST off.

## Privacy

See [PRIVACY.md](PRIVACY.md). Results stay in memory for the session. Customer, address, and account fields are omitted. There is no telemetry.

## Limits

- Download-file only. No utility login, OAuth, Green Button Connect, or Share My Data.
- No network calls. An `https` href inside the XML is an identifier, not a request.
- Memory is discarded when the process exits. Nothing is written unless you call `export_normalized`.
- Zip files are rejected. Files larger than 32 MB are rejected.
- The cost tool is an estimate. It does not model demand charges, baseline allowances, net-metering true-up, taxes, or a minimum bill. Tiers reset on calendar months that contain readings, and the fixed monthly charge is added once per such month. Time-of-use windows use the local hour of the interval start; the first matching window wins; `endHour` is exclusive.
- File costs are used when any selected reading has one, unless `useFileCost` is false.
- CSV support is the column map above. A file that does not match it will not parse.
- IANA timezone names are not resolved. Without `LocalTimeParameters`, `localHour` is the UTC hour.
- Meter and usage-point ids from the file are kept. If a utility embeds an account number in that id, the id is still returned.
- Not every utility quirk is covered. Missing links, a missing namespace prefix, and a single resource (instead of an Atom feed) are accepted. A file that is neither ESPI nor the CSV shape above fails.
- This repository is not submitted to a marketplace.

## License

MIT.
