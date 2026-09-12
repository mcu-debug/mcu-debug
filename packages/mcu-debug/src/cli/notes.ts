import { apply_patch } from "jsonpatch";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../common/logger";

/**
 * How long a burst of `!!NOTE:` patches may sit in memory before being written. Short enough
 * that a crash loses little, long enough that a flurry costs one write instead of dozens.
 */
const NOTES_FLUSH_MS = 250;

/**
 * Session notes: a workspace-wide `.mcu-debug/notes.json`, keyed by launch-config name, that an
 * AI updates with `!!NOTE:` JSON Patches and reads back on a later session.
 *
 * **Every filesystem call in here is deliberately synchronous, and that is what makes it
 * correct.** Node does not yield inside a synchronous call, so the read-merge-write in
 * saveNotes() cannot interleave with another one: two `!!NOTE:` commands arriving back to back
 * are serialised for free, even though the input handlers that deliver them are async.
 *
 * Converting these to `fs.promises` would look like a modernisation and would silently break
 * that -- two patches could then read, read, write, write and lose one. If this ever needs to
 * become async, it needs an explicit queue or lock at the same time, not afterwards.
 *
 * None of this helps across *processes*. Two CLI sessions in one workspace still race; see the
 * note in saveNotes() about how far the merge narrows that window.
 *
 * Writes are **coalesced**, because `!!NOTE:` is issued by an AI rather than typed by a person.
 * A burst of patches is normal, and socket input makes it worse: readline emits every complete
 * line in a received chunk synchronously in a row, so fifty notes in one TCP segment would
 * otherwise be fifty whole-file rewrites -- of a file that grows -- back to back, with no yield
 * in between to let RTT, serial or GDB traffic through. Patches land in memory immediately and
 * at most one write happens per {@link NOTES_FLUSH_MS}.
 */
export class NotesManager {
    private notesFile: string;
    private flushTimer: NodeJS.Timeout | null = null;
    /** Configs patched since the last write. A set, not a single name: saveNotes merges only the
     *  entries it is told about, so keeping just the most recent one would drop the others. */
    private pendingConfigs = new Set<string>();
    private notes: { [name: string]: any } = {};
    private mtime: number = 0;

    // We use the same timestamp for the entire session regardless when we actually create/update the various session files
    constructor(private sessionTimestamp: string) {
        this.notesFile = `${process.cwd()}/.mcu-debug/notes.json`;
        this.loadNotes();
    }

    /**
     * Read and parse the file without touching instance state, so callers can merge against it.
     * Returns null only when the file exists but could not be read or parsed.
     */
    private readFromDisk(): { map: Record<string, any>; mtime: number } | null {
        if (!fs.existsSync(this.notesFile)) {
            return { map: {}, mtime: 0 };
        }
        try {
            const mtime = fs.statSync(this.notesFile).mtimeMs;
            const stuff = JSON.parse(fs.readFileSync(this.notesFile, 'utf-8'));
            if (!Array.isArray(stuff)) {
                // Wrong shape: treat as empty, but still record the mtime so we do not decide the
                // file has changed on every single patch from here on.
                return { map: {}, mtime };
            }
            const map = stuff.reduce((acc: Record<string, any>, note: any) => {
                acc[note.name] = note;
                return acc;
            }, {});
            return { map, mtime };
        } catch (err) {
            logger.error(`Failed to load notes from ${this.notesFile}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    private loadNotes() {
        const disk = this.readFromDisk();
        this.notes = disk?.map ?? {};
        this.mtime = disk?.mtime ?? 0;
        logger.debug(`Loaded ${Object.keys(this.notes).length} notes from ${this.notesFile}`);
    }

    applyPatches(configName: string, patches: any[]) {
        const mtime = fs.existsSync(this.notesFile) ? fs.statSync(this.notesFile).mtimeMs : 0;
        if (mtime !== this.mtime) {
            logger.warn(`Notes file ${this.notesFile} has been modified since it was last loaded. Reloading notes to avoid overwriting external changes.`);
            this.loadNotes();
        }
        const existing = this.notes[configName] ?? {};
        try {
            this.notes[configName] = apply_patch(existing, patches);
        } catch (err) {
            logger.error(`Failed to apply notes patches for config ${configName}: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        this.scheduleFlush(configName);
    }

    /**
     * Write at most once per window, keeping the *first* deadline rather than pushing it back on
     * every patch. A debounce would starve under a continuous stream of notes -- which is
     * exactly what an agent working through a problem produces -- so this bounds latency instead:
     * whatever has accumulated is on disk within NOTES_FLUSH_MS of the first patch in a burst.
     */
    private scheduleFlush(configName: string) {
        this.pendingConfigs.add(configName);
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushNow();
        }, NOTES_FLUSH_MS);
        this.flushTimer.unref();    // never hold the process open for housekeeping
    }

    /**
     * Write any pending patches out now. Safe to call when nothing is pending.
     *
     * Called from the driver's dispose(), which runs on process `exit` -- a context where only
     * synchronous work can happen, which is why the writer must stay synchronous.
     */
    public flushNow() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.pendingConfigs.size === 0) {
            return;
        }
        const configNames = [...this.pendingConfigs];
        this.pendingConfigs.clear();
        this.saveNotes(configNames);
    }

    /**
     * Replace `file` with `data` atomically: write a sibling temp file, then rename over the
     * target. A plain writeFileSync truncates first, so a crash, a power loss or the `kill -9`
     * we tell users to avoid, landing in that window, would leave the file truncated -- and this
     * file is the cumulative record across every session, not just this one's notes.
     *
     * Rename is atomic on POSIX and replaces on Windows. The pid in the temp name keeps two
     * sessions in one workspace from colliding on it.
     */
    private writeFileAtomic(file: string, data: string) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, data);
        try {
            fs.renameSync(tmp, file);
        } catch (err) {
            try {
                fs.unlinkSync(tmp);
            } catch { /* best effort */ }
            throw err;
        }
    }

    private saveNotes(configNames: string[]) {
        try {
            // Re-read and merge immediately before writing. We serialise the *whole* file, so a
            // config another session owns would otherwise be rolled back to whatever we happened
            // to load at startup. Only the configs we were actually asked about are overwritten.
            // This does not make concurrent writes safe -- it shrinks the window from the length
            // of the session to the gap between this read and the rename.
            const disk = this.readFromDisk();
            if (disk) {
                const merged = { ...disk.map };
                for (const name of configNames) {
                    merged[name] = this.notes[name];
                }
                this.notes = merged;
            }
            const jsonStr = JSON.stringify(Object.values(this.notes), null, 2);
            fs.mkdirSync(path.dirname(this.notesFile), { recursive: true });
            this.writeFileAtomic(this.notesFile, jsonStr);
            this.mtime = fs.statSync(this.notesFile).mtimeMs;
            try {
                const archiveFile = `${process.cwd()}/.mcu-debug/archive/${this.sessionTimestamp}-notes.json`;
                fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
                this.writeFileAtomic(archiveFile, jsonStr);
                logger.debug(`Archived notes to ${archiveFile}`);
            } catch (err) {
                // The archive copy is a convenience; notes.json above is the record that matters.
                logger.debug(`Could not archive notes: ${err instanceof Error ? err.message : String(err)}`);
            }
        } catch (err) {
            logger.error(`Failed to save notes to ${this.notesFile}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
