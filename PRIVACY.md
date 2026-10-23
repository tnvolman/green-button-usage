# Privacy

Green Button usage v0.1 reads a file you already downloaded. It does not log in to a utility, does not use OAuth, and does not make network calls.

## What stays on this machine

- The server keeps the parsed meters, readings, and bill periods in process memory. That includes the original meter ID, so a later call can pass either that ID or its masked form.
- That memory is dropped when the MCP process exits. The plugin does not write a cache, a database, or a telemetry record.
- The only file it writes is the one you ask `export_normalized` to write, at the path you give. If that path already exists, the write is refused unless you pass `overwrite: true`. Account-like meter IDs in that file are masked the same way as tool results.

## What is left out of results

Tool results and exports do not include customer, account, or postal-address elements from the file. Columns and preamble lines for name, address, and account number in a CSV are dropped the same way.

A meter ID with 6 or more digits is treated as an account number. Before any tool returns it, the ID is replaced with `****` plus its last 4 characters, for example `990000001234` becomes `****1234`. The full meter ID does not appear in the result, in warning text, or in an export. A meter ID with fewer than 6 digits is returned unchanged. There is no switch that turns the mask off.

Usage-point IDs are still returned as stored. A utility that puts an account number only in a usage-point ID will still show that ID. If a usage-point ID contains a meter ID that is being masked, that meter ID text is removed from the result along with every other copy.

## What this is not

This plugin is not a utility, and it is not affiliated with the Green Button Alliance, NAESB, PG&E, SCE, Con Edison, or SDG&E. Cost figures are estimates. The original download stays where you saved it.
