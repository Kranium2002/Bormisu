"""Sign-in (contract 1.4.0): email and password accounts, cookie sessions, the signed-in user as actor.

Minimal by design (hackathon scope): register, login, logout, me; no rate limits, no Origin check, no
password change in the browser (reset from the command line: python -m app.users).

- `passwords`: argon2id hashes.
- `policy`: the rules for emails, passwords (8 to 128 characters) and display names, as 422 field errors.
- `sessions`: the `gm_session` cookie and the `sessions` table (SHA-256 of the token, never the token).
- `service`: register, authenticate, reset a password (shared by the routes and the CLI).
- `deps`: `current_user` (every protected route) and `actor_name`.
"""
