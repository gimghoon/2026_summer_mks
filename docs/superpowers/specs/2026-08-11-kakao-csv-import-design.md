# KakaoTalk CSV Import Design

## Goal

Accept the KakaoTalk CSV export format supplied by the user while preserving the existing Korean date-based text export behavior. A successful CSV import must create the same participant, message, turn, chunk, and analysis inputs as an equivalent text export.

## Supported Inputs

The importer continues to support the existing `.txt` format. It additionally supports UTF-8 CSV whose first record contains exactly the KakaoTalk columns `Date`, `User`, and `Message` in that order.

CSV timestamps use `YYYY-MM-DD HH:mm:ss` and represent Asia/Seoul local time. `User` is the participant name and `Message` is the complete message body. Standard CSV quoting rules apply, including commas, escaped double quotes, CRLF or LF records, and quoted messages containing line breaks.

Other CSV schemas remain unsupported. Encoding conversion such as CP949-to-UTF-8 is outside this change because the supplied export is UTF-8.

## Architecture

`parseKakaoExport` remains the single public parsing entry point. It removes an optional UTF-8 BOM, detects the CSV header, and delegates to a focused CSV-record parser or the existing text parser. Both paths produce the existing `ParsedKakaoExport` contract so participant resolution, fingerprinting, deduplication, turn grouping, encryption, and incremental import require no format-specific changes.

The CSV-record parser is a small dependency-free state machine limited to the accepted three-column schema. It tracks quoted fields, escaped quotes, record boundaries, and the physical source line where each record starts. This avoids adding a runtime dependency while correctly handling message content that cannot be parsed with line splitting.

Fingerprint ordinals are assigned only after complete CSV records have been parsed, matching the existing multiline-text behavior. Re-importing an identical export therefore produces the same fingerprints and no duplicate stored messages.

## Import Flow

1. The upload UI accepts `.txt` and `.csv` files and labels both formats clearly.
2. The API reads the bounded upload exactly as it does today.
3. The parser detects CSV by its decoded header, not solely by the filename.
4. CSV rows are converted to parsed messages using Asia/Seoul timestamps.
5. The API derives a room title from the parsed title when present, otherwise from the filename with either `.txt` or `.csv` removed.
6. Before creating or updating a room, the API rejects an input that contains zero valid messages.
7. Valid parsed data proceeds through the existing transactional import service.

## Validation and Errors

The importer returns HTTP 400 with a generic Korean-facing invalid-format response when the file has an unsupported header or zero valid messages. No room, participant, message, or turn is created in that case.

Malformed CSV records are added to `unparsedLines` when recovery is possible. A structurally incomplete quoted record at end of file is reported as unparsed rather than silently accepted. Valid records before or after recoverable malformed records continue to import. Existing request and file-size limits remain unchanged.

The response and logs must not expose imported message text beyond the existing user-visible unparsed-line review behavior.

## Testing

Tests use a synthetic three-column fixture rather than the user's private export. Coverage includes:

- UTF-8 BOM and the exact `Date,User,Message` header;
- Asia/Seoul timestamp conversion;
- participant and message extraction;
- commas, escaped quotes, CRLF, and multiline quoted messages;
- deterministic fingerprints and identical-export deduplication;
- continued parsing of existing `.txt` fixtures;
- `.csv` selection and labeling in the upload UI;
- room-title derivation for `.csv` filenames;
- HTTP 400 and zero persistence for a file with no valid messages.

The implementation is complete only when focused parser/import/API/UI tests, the full unit and integration suites, TypeScript checking, and the production build pass.
