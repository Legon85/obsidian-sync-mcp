export interface IndexedNotePath {
    path: string;
    mtime: number;
}

export interface AuthoritativeNotePath {
    path: string;
    mtime: number;
}

export interface IndexPathDiff {
    stalePaths: string[];
    missingNotes: AuthoritativeNotePath[];
}

/**
 * Compare the persisted metadata index with the authoritative Vault listing.
 *
 * stalePaths:
 *   paths still present in SearchIndex but absent from the Vault.
 *
 * missingNotes:
 *   paths present in the Vault but absent from SearchIndex.
 *
 * Paths are treated as opaque Vault-relative strings. Consecutive dots inside
 * valid filenames are therefore not interpreted as traversal.
 */
export function diffIndexPaths(
    indexedNotes: Iterable<IndexedNotePath>,
    authoritativeNotes: Iterable<AuthoritativeNotePath>,
): IndexPathDiff {
    const indexed = new Set<string>();

    for (const note of indexedNotes) {
        indexed.add(note.path);
    }

    const authoritative = new Map<string, AuthoritativeNotePath>();

    for (const note of authoritativeNotes) {
        authoritative.set(note.path, note);
    }

    const stalePaths = [...indexed]
        .filter((path) => !authoritative.has(path))
        .sort();

    const missingNotes = [...authoritative.values()]
        .filter((note) => !indexed.has(note.path))
        .sort((a, b) => a.path.localeCompare(b.path));

    return {
        stalePaths,
        missingNotes,
    };
}
