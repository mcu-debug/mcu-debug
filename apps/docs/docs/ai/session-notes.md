---
sidebar_position: 4
title: Session Notes
---

# Session Notes

## Overview

Session notes are a persistent JSON file that serves as the AI's working memory across target resets, context compactions, and multiple sessions on the same project. They answer the question: "what did we figure out last time?"

## Location

```
.mcu-debug/
  notes.json           ← workspace notes for all configs (always up to date)
  cli.log              ← full session log
  archive/
    2026-05-24T16-33-notes.json   ← full workspace notes snapshotted at session start
    2026-05-24T16-33-cli.log      ← log archived at session end
```

The archive file is created at session start and updated in parallel with `notes.json` on every `!!NOTE` write. The timestamp in the archive filename marks the session start time. A crash leaves both files intact and consistent.

## Structure

`notes.json` is **workspace-wide** — it covers all launch configs, keyed by config name. Each config has its own independent notes section.

```json
{
  "Launch PSoC6 CM4": {
    "working_theory": "DMA callback never fires — suspect IRQ not linked",
    "ruled_out": [
      "Clock configuration — HFCLK verified stable at 144 MHz",
      "DMA channel allocation — channel 0 confirmed available"
    ],
    "breadcrumbs": [
      "Hard fault at 0x0800_1A3C on third DMA transfer iteration",
      "Fault address is inside the DMA callback function — stack overflow?"
    ],
    "open_questions": [
      "Is the DMA IRQ handler present in the map file?",
      "Stack size of the task calling DMA_Start?"
    ]
  },
  "Debug STM32 FreeRTOS": {
    "working_theory": "...",
    "ruled_out": [],
    "breadcrumbs": [],
    "open_questions": []
  }
}
```

Fields within each config section are flexible — the AI can add any fields useful for the investigation. If no section exists yet for the current config, treat it as a blank slate.

## Writing Notes

Use the `!!NOTE` meta-command with a JSON Patch (RFC 6902). Patch paths are **relative to the active config's section** — mcu-debug scopes them automatically. Write `/working_theory`, not `/Launch PSoC6 CM4/working_theory`.

```
!!NOTE: [{"op":"replace","path":"/working_theory","value":"DMA IRQ not in map file"}]
```

```
!!NOTE: [{"op":"add","path":"/ruled_out/-","value":"IRQ priority — checked NVIC, all clear"}]
```

```
!!NOTE: [{"op":"add","path":"/breadcrumbs/-","value":"Fault at 0x08001A3C on iteration 3 of 5"}]
```

```
!!NOTE: [{"op":"add","path":"/open_questions/-","value":"Is DMA_IRQHandler weak symbol overridden?"}]
```

Multiple operations in one patch:

```
!!NOTE: [{"op":"replace","path":"/working_theory","value":"Stack overflow in DMA task"},{"op":"add","path":"/ruled_out/-","value":"DMA channel config — verified correct"}]
```

If the patch fails (e.g. invalid path), mcu-debug reports:

```
[mcu-debug] NOTE: patch failed — "path /open_questions/-: target not an array"
```

## Reading Notes

Read `.mcu-debug/notes.json` directly using file tools. No special command needed. The file is always valid JSON.

## Across Sessions

`notes.json` persists between sessions and covers all configs in the workspace. At session start, read `notes.json` and look up the section for the current config name:

- Start from the current `working_theory` rather than a blank slate
- Don't re-investigate things in `ruled_out`
- Check `open_questions` — they may be answerable immediately
- If no section exists for this config yet, start fresh

Do not carry over `working_theory`, `breadcrumbs`, or `open_questions` from another config's section — investigations are independent per config.

This makes multi-session investigations dramatically more efficient.

## Note-Taking Discipline

Update notes:

- When you rule something out — add to `ruled_out`
- When you find something interesting — add to `breadcrumbs`
- When your theory changes — update `working_theory`
- When you identify something to check next — add to `open_questions`

Update notes **before** context compaction happens, not after. Compaction discards the conversation history but notes.json survives.
