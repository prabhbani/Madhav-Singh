/**
 * Deterministic 32-bit FNV-1a hash.
 *
 * Used for identifiers and condition fingerprints that must stay stable across
 * runs and processes, which is what lets stored state be matched back to a newly
 * computed result. It is not a cryptographic hash and must not be used as one.
 */
export const fingerprint = (value) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};
