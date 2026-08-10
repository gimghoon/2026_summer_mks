# Bounded Conversation Chunks Design

## Problem

Room analysis currently starts a new chunk only at a 30-minute gap, a Seoul calendar-day change, or an explicit topic boundary. A real imported room produced one continuous chunk containing 136 turns and approximately 205 messages over 5 hours 45 minutes. OpenAI rejected that chunk with HTTP 400 on one attempt and returned an invalid evidence reference on another. The first ten chunks were checkpointed correctly, so resumability works; chunk sizing is the remaining blocker.

## Decision

Keep every existing semantic and time boundary, and add a hard maximum of 20 turns per chunk. The limit is deterministic and applies even when participants converse continuously without a 30-minute pause.

For example, a 136-turn continuous range becomes six 20-turn chunks followed by one 16-turn chunk. A natural boundary that occurs before turn 20 still ends the chunk early. The counter restarts after every boundary.

## Data Flow

`chunkTurns` remains the single partitioning function. It emits a boundary when either:

1. the next turn would make the current chunk exceed 20 turns;
2. the gap is at least 30 minutes;
3. the Asia/Seoul calendar date changes; or
4. an explicit topic boundary starts at that turn.

The existing reconciliation step runs before every analysis. Exact unchanged partitions retain their chunk IDs and prepared analysis. Oversized partitions are replaced by bounded partitions. Existing analysis lineage is retained through the reconciliation repository so stale profile facts can still be cleaned safely. The progress run is restarted with the newly calculated total and clamps any prior completed count to that total.

## Failure and Retry Behavior

No OpenAI call is made for an oversized partition after this change. Each bounded chunk is still checkpointed immediately after successful extraction and embedding. If a later chunk fails, retry skips every same-fingerprint prepared chunk and resumes at the first unfinished bounded chunk.

The UI continues to poll persisted progress. Its denominator may increase after reconciliation because one old partition can become several bounded partitions; this is expected and reflects actual work.

## Testing

Add a unit regression proving that 136 continuous turns become `[20, 20, 20, 20, 20, 20, 16]` while natural time/date/topic boundaries still take precedence. Add an integration regression proving reconciliation covers every turn exactly once, retains stable IDs for unchanged leading chunks, replaces the oversized partition, and produces no chunk over 20 turns.

Run the focused chunker/reconciliation tests, all unit and integration tests, TypeScript, and the production build. Do not run a paid full-room analysis automatically; after verification, the user can restart the development server and retry the existing room from its checkpoint.

## Scope

This change does not introduce token counting, message-count limits, dynamic topic detection, or provider-specific retry behavior. Those are unnecessary for the observed failure and can be considered separately if a future single turn contains unusually large content.
