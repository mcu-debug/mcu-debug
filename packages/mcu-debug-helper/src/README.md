# MCU Debug Helper

This program extends the MCU Debug Debug Adapter with a small helper process that performs heavy-weight work (symbol table construction, disassembly via objdump, etc.) and exposes results to the DA over a JSON-RPC-like channel.

Rationale and scope
- objdump gives better ARM disassembly than GDB for our use-cases, but it is still imperfect (limited line-number information, oddities around optimized code). The helper runs alongside the DAP, shares its lifecycle, and provides on-demand services to keep the adapter responsive.

Functionality / services
1. Symbol table access (useful for the disassembler and other features)
   - All globals
   - Statics per file
   - Individual symbol queries
2. On-demand disassembly (adapter follows the DAP Disassemble request/response semantics; see the DAP spec)

This README documents the helper ↔ DA messaging patterns, event names, and a compact wire format used internally to keep payloads small and fast.

## Protocol notes

We use a JSON-RPC style channel between the helper (Rust) and the DA (TypeScript). The channel carries two kinds of messages:
- Notifications (events) — no `id`, one-way from helper to DA
- Requests/Responses — request messages (with `id`) from the DA to helper and matching responses back

Event characteristics
- Events are notifications (no `id`). Example events:
  - `SymbolTableReady` — sent once when the global symbol table has been constructed. Note: symbol table is global across all input ELF files in this design.
  - `RTTAddress` — optional, sent as soon as RTT info is discovered (may be omitted).
  - `DisassemblyReady` — optional; typically the DA will request disassembly directly and the helper replies (see chunking rules below).

Always include `sessionId` and `helperVersion` in the initial handshake or in events, so the DA can detect stale messages or version incompatibilities.

Example notification (SymbolTableReady):
```json
{"jsonrpc":"2.0","method":"SymbolTableReady","params":{"sessionId":"abcd-1234","helperVersion":"0.1.0"}}
```

### Disassembly payloads (compact wire format)

To keep throughput high we use a compact, array-based message for disassembly when sending bulk data from helper → DA. Each asm line is an object with a very small field names. xxx. We chose this instead of a tuple of strings just to keep debugging easier and yet be compact. VSCode max ask was about 400 instructions which may turn out to be ~32KB. Most often, it is just 50 instructions

(Note: Address is a hex string without a prefix to be JSON compatible, no leading zero. Can be upto 64 bits

Example message:
```json
{
   "t":"disasm_response",
   "seq":42,
   "file_table":{"1":"file1.c"},
   "func_table":{"2":"func1"},
   "instructions":[
      {"a":"4096","b":"00 20","i":"movs r0,#0","f":-1,"F":-1,"sl":-1,"el":-1},
      {"a":"40AC","b":"01 30","i":"adds r0,r1","f":-1,"F":-1,"sl":-1,"el":-1}
   ]
}
```

Notes about the compact format
- `addressHex` is a hex string (eg. "0x1000") to avoid JS integer precision issues and make parsing trivial.
- `bytesHex` is a human-readable hex string (space separated or compact) — there is no other binary data in the payload.
- `instructionText` and `rawLineText` are UTF-8 strings. Use `from_utf8_lossy` on the Rust side if needed; DA should treat names and text as Unicode strings.

VS Code expects a single valid DAP response per `Disassemble` request. You must not stream multiple partial DAP responses to VSCode for a single `Disassemble` request.

### Errors, timeouts and backpressure
- If a DA request arrives before `SymbolTableReady`, the DA may wait with a configurable timeout. If timed out, return a DAP error response to VSCode (do not block the UI indefinitely).
- The helper and DA must tolerate request storms from VSCode: dedupe equivalent requests, debounce frequent back-to-back requests, and prefer cached results when possible.

### Example: compact -> DAP conversion (high level)
- Compact message (helper → DA): `disasm_chunk` (as above)
- DA assembles lines into DAP instructions and constructs the DAP response:
```ts
{ instructions: [ { address: '0x1000', instruction: 'movs r0,#0', rawBytes: '00 20', raw: ' 1000: 00 20 movs r0,#0' }, ... ] }
```

### Versioning and session
- Include `sessionId` in events and optionally in chunk messages so the DA can drop stale chunks from previous sessions.
- Include `helperVersion` so the DA can detect incompatible message shapes.

## Implementation notes
- The helper should emit compact chunks as quickly as possible (reuse buffers, minimize allocations). The DA performs the JSON.parse + conversion to DAP objects.
- Keep the transport and payload separate: the transport implements framed JSON (Content-Length headers) and the payloads follow the compact shapes above.
