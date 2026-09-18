Your slow load times are likely due to a cache invalidation issue on the
edge nodes serving your origin. When the CDN cache expires or gets purged,
requests fall through to the backend and get served uncached, which
increases server-side latency significantly. I've re-enabled edge caching
and warmed the cache, which should reduce TTFB back to baseline within a
few minutes. Let me know if latency is still elevated after the cache
finishes propagating.
