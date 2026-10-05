# MCU Debug — Claude Context

See [AGENTS.md](AGENTS.md) for all architectural context, terminology, and key reference documents.

It also carries the **operational commands you are expected to use** — see its *Building*,
*Rust formatting*, and *Rust linting* sections. In particular: use `npm run test:rust` rather
than bare `cargo test`, and `npm run fmt:rust` rather than `rustfmt <file>`. A bare `cargo test`
does not update the ts-rs generated TS in `packages/shared` (only the wrapper syncs it), and a
bare `rustfmt` leaves unrelated files modified.
