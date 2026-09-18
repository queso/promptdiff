"""A tiny LRU cache used by the router."""


class LRUCache:
    def __init__(self, capacity):
        self.capacity = capacity
        self._data = {}
        self._order = []

    def get(self, key):
        if key not in self._data:
            return None
        self._order.remove(key)
        self._order.append(key)
        return self._data[key]

    def put(self, key, value):
        if key in self._data:
            self._order.remove(key)
        elif len(self._data) >= self.capacity:
            oldest = self._order.pop(0)
            del self._data[oldest]
        self._data[key] = value
        self._order.append(key)
