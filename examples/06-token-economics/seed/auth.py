"""Session and token handling."""

import secrets


def create_session(user_id):
    return {"user_id": user_id, "token": _new_token()}


def _new_token():
    return secrets.token_hex(16)


def validate_session(session, token):
    return session.get("token") == token
