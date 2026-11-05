---
name: search-logs-cca-demo
description: Query and interpret cca-demo RecoverBoard service logs in the configured Scaleway Loki datasource. Use when investigating application requests, errors, or runtime behavior from logs.
---

# Query cca-demo Loki logs

Use Grafana's Loki tools in codemode, targeting the configured Loki datasource **Scaleway Logs - fr-par** (UID `bg39rm03io5j4c`). For the `cca-demo` project, use this selector and JSON parsing pipeline as the base of every log query:

```logql
{resource_type="serverless_container", project_name="cca-demo"} | json
```

Add filters or parsing expressions after this base only when needed. Keep the selector's positive label matchers so queries remain scoped to the project. For example, filter message text with `|= "error"` or parsed fields with an appropriate LogQL pipeline, while preserving the base selector.

**Do not use Loki label-discovery queries** (`list_loki_label_names` or `list_loki_label_values`) to start investigations: they fail with HTTP 400 for this datasource. Do not substitute guessed service labels as the base selector. Query logs directly using the base query above; use the parsed `resource_name` / `resource_instance` fields in returned entries to identify the application service and deployment.

Specify the requested time range explicitly, in RFC3339 timestamps when relative time strings are rejected. Use a sensible result limit and report the actual queried window, returned-line count/truncation if available, and notable errors or slow requests. Distinguish observed logs from inferences; no returned entries do not prove that the service is healthy or that no activity occurred if the selector/time range may not match.
