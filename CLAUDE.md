# MCU Debug — Claude Context

See [AGENTS.md](AGENTS.md) for all architectural context, terminology, and key reference documents.

It also carries the **operational commands you are expected to use** — see its *Building*,
*Rust formatting*, and *Rust linting* sections. In particular: use `npm run test:rust` rather
than bare `cargo test`, and `npm run fmt:rust` rather than `rustfmt <file>`. Both exist because
the raw commands leave unrelated files modified, which costs time to notice and undo.
