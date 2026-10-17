"""Sign-in (contract 1.3.0): email and password accounts, cookie sessions, the signed-in user as actor.

- `passwords`: argon2id hashes and the common-password list (data/common_passwords.txt).
- `policy`: the rules for emails, passwords and display names, as 422 field errors.
- `sessions`: the `gm_session` cookie and the `sessions` table (SHA-256 of the token, never the token).
- `limits`: in-memory sign-in and registration limits per API process.
- `service`: register, authenticate, change password, set role (shared by the routes and the CLI).
- `deps`: `current_user` (every protected route), `actor_name`, the Origin check on writes.
"""
