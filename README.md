# Green Button usage

A local Cursor plugin that reads a Green Button file you already downloaded and summarizes electric, gas, or water use on your machine. No login and no network calls.

Version 0.1.0 reads a file from disk. It does not use OAuth, Green Button Connect, or Share My Data. The server is `server/greenbutton-mcp.js`: zero dependencies, JSON-RPC over stdio, and it never opens a socket.

Author: Michael McClanahan (@tnvolman). License: [MIT](LICENSE).

## Setup

Node.js 18 or newer. There is no `package.json` and nothing to install with npm. `scripts/prove.js` runs the suite with `node --test`.

```bash
git clone https://github.com/tnvolman/green-button-usage
cd green-button-usage
node scripts/prove.js
```

Cursor loads this directory as an agent plugin. [`plugin.json`](plugin.json) is the manifest (`green-button` 0.1.0). [`mcp.json`](mcp.json) starts the server with `node` over stdio:

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

Download the Green Button file from your utility yourself (often labeled Download My Data). Unzip a `.zip` first. This plugin never logs in and never fetches the file. An `https` href inside the XML is an identifier, not a request.

## Usage

[`skills/green-button/SKILL.md`](skills/green-button/SKILL.md) is the instruction sheet for the agent. Load a file, then ask for a summary. Pass exactly one of `path`, `xml_text`, or `csv_text` to `load_greenbutton`.

| Tool | What you get |
| --- | --- |
| `load_greenbutton` | File id, meters, date range, and units. Customer, address, and account fields are omitted. |
| `list_usage_points` | Usage points and their meters. Pass `fileId` when more than one file is loaded. |
| `usage_summary` | Day, week, or month totals. `avg`, `min`, and `max` describe those bucket totals. |
| `peak_hours` | Top intervals, average by local hour, weekday versus weekend, baseload, and load factor. |
| `compare_periods` | Month-over-month, year-over-year, or two inclusive local date ranges. `perDay` divides by the calendar days in the window. |
| `estimate_cost` | Cost from the file when it has interval costs, or from a `flat`, `tou`, or `tiers` rate, plus an optional `fixedMonthly` charge. Always an estimate, never a bill. |
| `export_normalized` | CSV or JSON at a path you choose. The only disk write. Refuses to replace an existing file unless `overwrite` is true. |

Service category `0` is electric, `1` is gas, and `2` is water. `server/units.js` also names the other ESPI service-kind codes it recognizes. Flow direction `1` is delivered and `19` is received. When a file has both and you omit `direction`, summaries stay on delivered energy so solar export is not added to consumption. Pass `direction: "received"` for export, or `direction: "net"` for delivered minus received. `estimate_cost` and `peak_hours` take one direction, `delivered` or `received`.

On the synthetic fixture `samples/electric-hourly.xml` (not a customer's data):

```json
{ "path": "samples/electric-hourly.xml" }
```

```json
{
  "fileId": "gb_35b2fc67d5be",
  "meterId": "DELIVERED",
  "mode": "ranges",
  "periodA": { "start": "2024-07-01", "end": "2024-07-31" },
  "periodB": { "start": "2024-01-01", "end": "2024-01-31" }
}
```

The first object is `load_greenbutton`. The second is `compare_periods` for that file's delivered meter. July starts at `07:00Z` and January at `08:00Z` because the fixture's `LocalTimeParameters` are Pacific time with daylight saving.

### CSV format

ESPI XML is the Green Button feed. The CSV reader is a fallback for one column layout, not every utility export. A file that does not match it fails and tells you to see this section.

- Rows before the header are ignored. A header is the first row that has both a date column and a usage column.
- The delimiter is a comma. Quoted fields are allowed.
- Date columns: `Date`, `Start Date`, `Usage Date`, `Day`, `Read Date`. `YYYY-MM-DD` or `MM/DD/YYYY`.
- Time columns: `Start Time`, `End Time` (`HH:MM` or `h:mm AM/PM`). An end time that is not after the start rolls to the next day. With no start time, the row is the whole local day.
- Usage columns: `Usage`, `Consumption`, `kWh`, `Wh`, `therms`, `gallons`, `Generation`, `Export`. A unit in the header or in a `Units` column is used. `Wh` is divided by 1000. Values are the numbers written in the file, not ESPI integers.
- `Cost` is dollars as written (a `$` and commas are allowed). It is not scaled by 10^-5 the way an ESPI `cost` is.
- `Direction`, or a note that says export, generation, or solar, marks received energy. A negative usage with no direction is treated as received and stored as a positive value.
- `Meter` becomes the meter id. `Type` of Electric, Gas, or Water sets the kind.
- `utc_offset` may be seconds (`-28800`) or `±HH:MM`. A whole number from -18 through 18 is read as hours. Without an offset, clock times are stored as UTC, `localHour` is the hour in the file, and the load result warns with `csv-naive-time`.
- Name, address, and account columns are not copied into the result.

`samples/usage-export.csv` is a synthetic file in this shape.

### Samples

All three samples are synthetic. Rebuild them with `node scripts/build-samples.js`. The name, street, and account number in them are fake and exist so tests can prove those fields are dropped.

| File | Contents |
| --- | --- |
| `samples/electric-hourly.xml` | One electric usage point, hourly, 1 Jan 2024 through 31 Jan 2025, Pacific Time with DST, delivered and received (solar) channels, monthly usage summaries. |
| `samples/gas-daily.xml` | Gas, daily therms for 2024, no Atom links, so the parser uses document order. DST is off. |
| `samples/usage-export.csv` | A short electric CSV with a preamble, a `utc_offset` column, and a few export rows. |

### How values are scaled

- An interval `value` is an integer. The quantity is `value * 10^powerOfTenMultiplier` in the ReadingType unit. `uom` 72 (Wh) is then divided by 1000 to kWh. `169` is therms. `128` is US gallons.
- `cost` and `billLastPeriod` use Green Button's fixed scale of 10^-5 of the currency unit. `100000` is 1.00 in the ReadingType currency (`840` is USD). The ReadingType multiplier does not scale the cost.
- `LocalTimeParameters.tzOffset` is standard time in seconds. DST rules are the 32-bit ESPI bitmap. `FFFFFFFF` turns DST off. Without `LocalTimeParameters`, `localHour` is the UTC hour. IANA timezone names are not resolved.

### Limits

- Files larger than 32 MB are rejected, and so are zip archives.
- Parsed meters stay in process memory and are dropped when the process exits. Nothing is written unless you call `export_normalized`.
- A meter ID or usage-point ID with 6 or more digits is returned as `****` plus its last 4 characters. Fewer than 6 digits is returned unchanged. You may pass either form back in; the result still shows the mask. If two IDs mask to the same 4 characters, passing that mask is an error, and the error does not contain either full ID.
- The parser keeps the last path segment of a meter or usage-point id. If that segment is empty, longer than 80 characters, or contains a character other than letters, digits, and `._:-`, it substitutes `usage-point-N` or `<usage-point-id>-meter-N`. A CSV meter value that fails the same check becomes `csv-meter-N`.

## Privacy

See [PRIVACY.md](PRIVACY.md). Results stay in memory for the session. Customer, address, and account fields are omitted. There is no telemetry.

## License

The code, docs, and sample files in this repository are [MIT](LICENSE), copyright (c) 2026 Michael McClanahan.

The three files in `samples/` are synthetic output of `scripts/build-samples.js`. The server reads an ESPI Atom document (`http://naesb.org/espi`) or the CSV layout above. It does not include or redistribute the NAESB ESPI standard. There are no npm dependencies.

This project is not a utility and is not affiliated with the Green Button Alliance, NAESB, PG&E, SCE, Con Edison, or SDG&E.

Built by Michael McClanahan (@tnvolman)
