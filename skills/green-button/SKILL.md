---
name: green-button
description: >
  Read a local Green Button download (ESPI XML or a utility usage CSV) and
  summarize home electric, gas, or water use. Use when the user has a Green
  Button file, interval usage, solar export, a bill-period comparison, or
  wants a rough cost estimate from their own meter data.
---

# Green Button usage

The file is already on disk. Do not log in, do not fetch it, and do not send it anywhere.

## Steps

1. Ask for the local path of the XML or CSV. Do not ask the user to paste an account number or address.
2. Call `load_greenbutton` with `path`. Use `xml_text` or `csv_text` only for a short snippet.
3. Call `list_usage_points` and keep delivered and received (solar export) on their own meters.
4. Use `usage_summary` (`day`, `week`, or `month`), `peak_hours`, and `compare_periods` (`mom`, `yoy`, or two inclusive local dates).
5. Call `estimate_cost` only with costs stored in the file or with a rate the user states. Say that the result is an estimate, not a bill.
6. Call `export_normalized` only when the user wants a file, and only to a path they choose.

## Rules

- If a tool returns an error, show that error. Do not invent intervals, totals, or prices.
- Default summaries are delivered energy. Pass `direction: "received"` for export and `direction: "net"` for delivered minus received.
- CSV clock times without a `utc_offset` column are stored as UTC. Say so when `warnings` includes `csv-naive-time`.
- Customer, address, and account fields are stripped. Do not repeat them even if the user can see them in the raw file.
