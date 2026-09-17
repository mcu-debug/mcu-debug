# xterm.js search addon — option changes never refresh highlights

Analysis of a defect in `@xterm/addon-search` 0.16.0, found while adding find to the MCU DEBUG
panel. We work around it in `Terminal.svelte`. **Not reported upstream.** Draft issue text is at
the end, along with the gaps to close before filing.

## Symptom

With `decorations` enabled, toggling **match case**, **whole word** or **regular expression**
while the search term stays the same leaves the previous highlights painted, and
`onDidChangeResults` keeps reporting the previous `resultCount`.

Measured in our panel against a buffer of 400 lines holding 62 matches for `heartbeat`:

| Step | `findNext()` returns | Reported count | Highlights painted |
| --- | --- | --- | --- |
| Search `heartbeat`, match case off | true | 62 | 22 visible |
| Switch match case on (no upper-case text in buffer) | **false** | **62** | **22 still painted** |

The correct result for the second row is 0 and 0. `findNext()` alone tells the truth — which is
what our workaround leans on.

The stale state persists until the *term* changes.

## Mechanism

`SearchAddon.findNext()` stores the incoming options on `SearchState` **before** asking whether
the highlights need recomputing:

```ts
// 0.16.0 lines 101-103, 0.17.0-beta.301 lines 108-110
this._state.lastSearchOptions = searchOptions;

if (this._state.shouldUpdateHighlighting(term, searchOptions)) {
  this._highlightAllMatches(term, searchOptions!);
}
```

`shouldUpdateHighlighting()` delegates to `SearchState.didOptionsChange(newOptions)`, which
compares `this._lastSearchOptions` field by field against `newOptions`:

```ts
// SearchState.ts, lines 58-75
if (this._lastSearchOptions.caseSensitive !== newOptions.caseSensitive) { return true; }
if (this._lastSearchOptions.regex !== newOptions.regex) { return true; }
if (this._lastSearchOptions.wholeWord !== newOptions.wholeWord) { return true; }
return false;
```

By that point `this._lastSearchOptions === newOptions` — it was just assigned. Every comparison
is between an object and itself, so after the first search (where `_lastSearchOptions` is
`undefined` and the early `return true` fires) `didOptionsChange()` can never return true again.

`shouldUpdateHighlighting()` is left with only its term comparison, so an options-only change is
invisible to it.

### The caller cannot dodge it

Passing a freshly built options object each time does not help: whatever object is passed is the
same object stored a line earlier. The addon's own internal refresh proves the point — on write
and on resize, `_updateMatches()` re-runs the search with a spread copy:

```ts
// 0.16.0 line 71
this.findPrevious(term!, { ...this._state.lastSearchOptions, incremental: true }, { noScroll: true });
```

That copy is still assigned before being compared against itself.

### Scope

- Both entry points. `findPrevious()` has identical ordering (0.16.0 lines 176/178,
  0.17.0-beta.301 lines 189/191).
- Only with `decorations` set — `shouldUpdateHighlighting()` returns false early otherwise, and
  `_fireResults()` only fires when decorations are enabled.
- Still present in the newest published beta, `0.17.0-beta.301`.

### It is a regression

0.15.0 compared *before* storing:

```ts
// 0.15.0 lines 137-138
const didOptionsChanged = this._lastSearchOptions ? this._didOptionsChange(this._lastSearchOptions, searchOptions) : true;
this._lastSearchOptions = searchOptions;
```

0.16.0 rewrote the addon into `SearchState`, `SearchEngine`, `SearchResultTracker` and
`DecorationManager`, and the ordering inverted in the process.

## Re-deriving the evidence

The published packages ship sourcemaps with full original TypeScript, so no clone is needed:

```sh
# The version we depend on
node -e "
const m=JSON.parse(require('fs').readFileSync('node_modules/@xterm/addon-search/lib/addon-search.js.map','utf8'));
const i=m.sources.findIndex(s=>/SearchAddon\.ts\$/.test(s));
console.log(m.sourcesContent[i]);" | sed -n '90,190p'

# Any other version, e.g. the beta or the last good one
npm pack @xterm/addon-search@beta      # or @0.15.0
tar xzf xterm-addon-search-*.tgz
```

`m.sources` lists `SearchAddon.ts`, `SearchState.ts`, `SearchEngine.ts`, `SearchResultTracker.ts`,
`DecorationManager.ts` and `SearchLineCache.ts`.

## Reproducing in our panel

1. Open a tab with output containing a lower-case word, say `heartbeat`.
2. `Ctrl+F` / `Cmd+F`, search `HEARTBEAT` — matches, because search is case-insensitive.
3. Click **Aa**. Without the workaround the count stays and the highlights remain, though
   nothing in the buffer matches case-sensitively.

## Our workaround

In `buildSearchDecorations()`'s caller, `handleFindToggle()` drops the decorations before
re-searching, which clears the addon's cached term and forces a fresh highlight pass:

```ts
searchAddon?.clearDecorations();
runSearch("next");
```

`runSearch()` additionally trusts `findNext()`'s return value over the reported count, so an
unmatched search reads *No results* even if a stale count arrives.

**`clearDecorations()` must be limited to option changes.** It also resets the cached term that
`_findNextAndSelect()` uses to decide whether to continue from the current match, so calling it
before every search makes `Enter` re-find the same match forever. We hit exactly that.

## Suggested upstream fix

Compare before storing, in both `findNext()` and `findPrevious()`:

```ts
const shouldUpdate = this._state.shouldUpdateHighlighting(term, searchOptions);
this._state.lastSearchOptions = searchOptions;
if (shouldUpdate) { this._highlightAllMatches(term, searchOptions!); }
```

Or have the `lastSearchOptions` setter store a copy of the three compared fields, which also
survives a caller that mutates one options object in place.

## Before filing — gaps to close

- **Duplicate check was weak.** `gh search issues --repo xtermjs/xterm.js` over open and closed
  issues found nothing for `didOptionsChange`, `addon-search highlight options` and
  `search decorations stale`, but keyword search misses differently-worded reports. Read through
  the open search-addon issues.
- **Not reproduced outside our app.** Everything above was measured in our panel (xterm 6.0.0 +
  addon-search 0.16.0, Chromium). Reproducing in xterm.js's own demo (`yarn start`, search addon
  enabled) would make the report much harder to argue with, and rules out our own code.
- **No test evidence.** The published tarball ships no tests, so whether a regression test exists
  upstream is unknown from here. Worth checking `addons/addon-search/test` in the repo.
- **Untested interaction:** `highlightLimit` (default 1000) and the `-1` result index it produces
  are a separate path from the one analysed here.
