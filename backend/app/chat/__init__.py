"""Chat assistant (contracts/realtime-and-chat.md section 2).

The model answers with server-side tools only: every count comes from SQL, every map action is an
allowlisted UI command built by a tool, and the reply streams as the AI SDK UI message stream v1.

- `commands`: the UI command allowlist (section 2.3).
- `stream`: chunk builders, the frame encoder and the ordered message writer.
- `tools` / `registry`: the server-side tools (section 2.4) and their strict function schemas.
- `prompts`: the system prompt from data/prompts/chat.txt, the context note and the user messages.
- `loop`: the OpenAI Responses loop (at most 8 tool rounds, 60 s per turn).
"""
