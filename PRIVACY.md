# Privacy

Green Button usage v0.1 reads a file you already downloaded. It does not log in to a utility, does not use OAuth, and does not make network calls.

## What stays on this machine

- The server keeps the parsed meters, readings, and bill periods in process memory.
- That memory is dropped when the MCP process exits. The plugin does not write a cache, a database, or a telemetry record.
- The only file it writes is the one you ask `export_normalized` to write, at the path you give.

## What is left out of results

Tool results and exports do not include customer, account, or postal-address elements from the file. Columns and preamble lines for name, address, and account number in a CSV are dropped the same way.

Meter and usage-point identifiers are kept so channels (including solar export) can be told apart. A utility that puts an account number inside a usage-point id will still show that id.

## What this is not

This plugin is not a utility, and it is not affiliated with PG&E, SCE, Con Edison, or SDG&E. Cost figures are estimates. The original download stays where you saved it.
