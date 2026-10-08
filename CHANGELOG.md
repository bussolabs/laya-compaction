# Changelog

## [Unreleased]

- **Compacted sessions survive `--resume`.** Kept assistant messages and tool results go back without their engine handle, so a resume no longer reloads the full history or repeats them. User prompts keep pasted images and documents. ([#89](https://github.com/tamaratran/fast-jev-compaction/issues/89)) ([#129](https://github.com/tamaratran/fast-jev-compaction/issues/129))
- **Parallel tool calls stay paired.** Truncating one result of a parallel group no longer splits the group, so Claude Code stops inserting "Tool result missing". ([#137](https://github.com/tamaratran/fast-jev-compaction/issues/137))
- **No broken characters at cuts.** Truncated texts and results never split an emoji or other surrogate pair, so the request and the history stay valid Unicode. ([#128](https://github.com/tamaratran/fast-jev-compaction/issues/128))
- **Malformed answers are rejected.** A probability outside 0–1, a mistyped or inherited answer, or an `answers` array stops the compaction before anything is deleted. ([#29](https://github.com/tamaratran/fast-jev-compaction/issues/29))
- **Keep thresholds must be between 0 and 1.** A threshold outside that range is refused instead of dropping calls Laya is certain about. ([#30](https://github.com/tamaratran/fast-jev-compaction/issues/30))
- **Ambiguous tool pairs fail closed.** Duplicate tool ids, duplicate results or a result before its call stop the compaction instead of deleting a pinned message. ([#31](https://github.com/tamaratran/fast-jev-compaction/issues/31))
- **Pending calls stay visible to Laya.** A tool call still waiting for its result now appears in the state, without being asked about. ([#32](https://github.com/tamaratran/fast-jev-compaction/issues/32))
- **At most four requests at a time.** Batches run four at a time and nothing new starts after a failure. ([#33](https://github.com/tamaratran/fast-jev-compaction/issues/33))
- **Requests have a deadline.** A Laya request gives up after 5 minutes (`timeoutMs`), and the library accepts a cancel `signal`; the hook falls back instead of waiting forever. ([#34](https://github.com/tamaratran/fast-jev-compaction/issues/34))
- **Better token estimate for hashes and IDs.** Hex strings, UUIDs and base64 count about one token per three characters, so fewer states get cut by the server. ([#81](https://github.com/tamaratran/fast-jev-compaction/issues/81))
- **Command echoes are not the goal.** `/compact` echoes, task notifications and system reminders no longer replace the user's task in the goal Laya reads. ([#70](https://github.com/tamaratran/fast-jev-compaction/issues/70))
- **`/compact` instructions reach Laya.** Text typed after `/compact` is added to the goal. ([#39](https://github.com/tamaratran/fast-jev-compaction/issues/39))
- **Subagents and precompute are left alone.** The hook leaves a subagent's transcript to Claude Code, skips precompute, and auto-compacts only after an answered main-loop turn. ([#107](https://github.com/tamaratran/fast-jev-compaction/issues/107))
- **One auto-compaction at a time.** The guard is taken before the first wait, so two overlapping turns cannot both start a compaction. ([#35](https://github.com/tamaratran/fast-jev-compaction/issues/35))
- **Display errors no longer break compaction.** A failing log or toast cannot undo a finished compaction or block the fallback to Claude Code's summary. ([#36](https://github.com/tamaratran/fast-jev-compaction/issues/36))

## [0.1.0] - 2026-10-08

- **First release as laya-compaction.** Port of fast-jev-compaction: Laya decides which tool calls and results to keep, on a laya-serve server (`LAYA_URL`) or on a shared local server with the multilingual model. Includes tuning sheets.
