- Serve static text assets with Brotli or gzip, compressed in memory at startup, and revalidate
  unhashed shell files with `ETag`. API and bootstrap responses and the release archive are
  unchanged. Text assets and shell files no longer answer byte-range requests.
