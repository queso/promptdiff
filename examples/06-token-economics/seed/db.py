"""Connection pool for the primary database."""


class ConnectionPool:
    def __init__(self, size):
        self.size = size
        self._pool = []

    def acquire(self):
        if not self._pool:
            return self._connect()
        return self._pool.pop()

    def release(self, conn):
        self._pool.append(conn)

    def _connect(self):
        return object()  # placeholder connection
