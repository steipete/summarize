# Dependency patches

## markdown-it 15.0.2

The patch backports the reference parser and inline HTML security fixes from the
published 15.0.3 package while that release completes our seven-day stabilization
hold. It addresses [GHSA-gfr2-rv44-r23c](https://github.com/advisories/GHSA-gfr2-rv44-r23c)
and [GHSA-vfgh-jcmw-g37q](https://github.com/advisories/GHSA-vfgh-jcmw-g37q).

Only the three affected parser sections are copied into the ESM and CommonJS
entrypoints. These are the package entrypoints used by the extension and tests;
the unused standalone `markdown-it/browser` bundles and source maps are unchanged.
The regression test exercises both patched entrypoints with unclosed reference
labels/titles and all four inline HTML constructs in subprocesses with deadlines.

Remove the patch when adopting 15.0.3 or newer after the stabilization hold. Keep
the behavioral regression tests.
