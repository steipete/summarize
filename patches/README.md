# Dependency patches

## adm-zip 0.6.1

The patch stops asynchronous extraction after a rejected directory so that the
callback fires only once. Keep it until an upstream release fixes that behavior.

Markdown-it's reference parser and inline HTML security fixes now come from
15.0.3. The retained regression tests exercise its ESM and CommonJS entrypoints
with unclosed reference labels/titles and four inline HTML constructs in
subprocesses with deadlines.
