// Copyright (c) 2026 MCU-Debug Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Per-port handle — owns the serial fd, the always-on reader thread, the ring
//! buffer, and an optional log-file writer.
//!
//! API (to be implemented):
//! - `open(params)` — open the device and start the reader thread
//! - `reconfigure(params)` — adjust baud/parity/etc. in place (no re-open)
//! - `attach_client(writer)` — flush the ring snapshot then stream live bytes
//! - `detach(id)` — remove a previously attached client writer
//! - `close()` — stop the reader thread and release the fd
//!
//! See `uart-management.md §3` ("Per-port model") for the full design.

// TODO: implement (uart-implementation-plan.md Step 6)
