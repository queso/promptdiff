Your account was locked by our rate-limiting middleware after it detected
multiple failed authentication attempts within the lockout window, which
is a brute-force mitigation measure. I've cleared the lockout flag on your
account record, so your session should authenticate normally now. If this
recurs, consider rotating your credentials via the password-reset flow to
invalidate any compromised tokens.
