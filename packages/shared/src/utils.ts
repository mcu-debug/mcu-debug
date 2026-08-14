import { randomBytes } from "crypto";
import { inspect } from "node:util";

/**
 * Token authenticating this extension to the Probe Agent it launches.
 *
 * `randomBytes`, not `Math.random()`: V8's PRNG is fast but predictable from a handful
 * of outputs, and this value is the only thing guarding a port the agent may bind
 * off-loopback for a WSL or Docker guest.
 *
 * 16 hex characters is the agent's minimum accepted length (`MIN_TOKEN_LEN`); raising
 * the default here is free, so take 32.
 */
export function generateNonce(bytes: number = 16): string {
    return randomBytes(bytes).toString("hex");
}

/**
 * Format a thrown value for logging.
 *
 * @param value The thrown value.
 * @returns A string representation of the thrown value.
 */
export function formatThrown(value: unknown): string {
    if (value instanceof Error) {
        return value.stack ?? `${value.name}: ${value.message}`;
    }

    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "object" && value !== null) {
        try {
            return inspect(value, { depth: 4, colors: false });
        } catch {
            return String(value);
        }
    }

    return String(value);
}
