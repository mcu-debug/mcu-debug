import { randomBytes } from "crypto";

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
export function generateNonce(bytes: number = 32): string {
    return randomBytes(bytes).toString("hex");
}
