"""Maps incoming HTTP paths to handler functions."""

ROUTES = {}


def route(path):
    def decorator(fn):
        ROUTES[path] = fn
        return fn

    return decorator


def dispatch(path, request):
    handler = ROUTES.get(path)
    if handler is None:
        return {"status": 404}
    return handler(request)
