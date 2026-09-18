This is expected behavior during DNS propagation. When you repoint your
domain's nameservers, the change has to propagate across recursive resolvers
worldwide, and each resolver caches records according to their TTL. Until
the TTL expires on every resolver in the chain, some clients will keep
resolving to the old A record. Propagation is typically complete within
24-48 hours depending on upstream caching behavior. No action is needed on
your end; the change will fully propagate once cached records expire.
