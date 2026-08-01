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

export interface ReconciliationIndex {
    listWithMtime(): IndexedNotePath[];
    update(path: string, content: string, mtime?: number): void;
    remove(path: string): void;
}

export interface ReconciliationVault {
    readNote(path: string): Promise<string | null>;
}

export interface ReconciliationResult {
    staleRemoved: number;
    missingRestored: number;
    missingUnreadable: number;
    verifiedNotes: number;
}

export function diffIndexPaths(
    indexedNotes: Iterable<IndexedNotePath>,
    authoritativeNotes: Iterable<AuthoritativeNotePath>,
): IndexPathDiff {
    const indexed = new Set<string>();

    for (const note of indexedNotes) {
        indexed.add(note.path);
    }

    const authoritative =
        new Map<string, AuthoritativeNotePath>();

    for (const note of authoritativeNotes) {
        authoritative.set(note.path, note);
    }

    return {
        stalePaths: [...indexed]
            .filter((path) => !authoritative.has(path))
            .sort(),

        missingNotes: [...authoritative.values()]
            .filter((note) => !indexed.has(note.path))
            .sort((a, b) => a.path.localeCompare(b.path)),
    };
}

/**
 * Reconcile the persisted metadata index with both:
 *
 * 1. the metadata-only Vault listing;
 * 2. the actual readability of every listed note.
 *
 * A path can still have a metadata document while its body/chunks are no
 * longer readable. Such paths must not remain visible through list_notes.
 *
 * Existing empty notes are preserved because readNote() returns an empty
 * string for a valid zero-byte note. A null result means the note cannot be
 * read and therefore must not remain visible through list_notes.
 */
export async function reconcileIndexPaths(
    index: ReconciliationIndex,
    vault: ReconciliationVault,
    authoritativeInput: Iterable<AuthoritativeNotePath>,
    onProgress?: (processed: number, total: number) => void,
): Promise<ReconciliationResult> {
    const authoritativeMap =
        new Map<string, AuthoritativeNotePath>();

    for (const note of authoritativeInput) {
        authoritativeMap.set(note.path, note);
    }

    const authoritativeNotes =
        [...authoritativeMap.values()]
            .sort((a, b) => a.path.localeCompare(b.path));

    const indexedNotes = index.listWithMtime();

    const indexedPaths =
        new Set(indexedNotes.map((note) => note.path));

    const pathDiff =
        diffIndexPaths(indexedNotes, authoritativeNotes);

    for (const path of pathDiff.stalePaths) {
        index.remove(path);
    }

    const missingPaths =
        new Set(pathDiff.missingNotes.map((note) => note.path));

    let staleRemoved = pathDiff.stalePaths.length;
    let missingRestored = 0;
    let missingUnreadable = 0;

    for (
        let position = 0;
        position < authoritativeNotes.length;
        position++
    ) {
        const note = authoritativeNotes[position];
        let content = await vault.readNote(note.path);

        if (content === null) {
            if (indexedPaths.has(note.path)) {
                index.remove(note.path);
                staleRemoved++;
            } else if (missingPaths.has(note.path)) {
                missingUnreadable++;
            }

            onProgress?.(
                position + 1,
                authoritativeNotes.length,
            );

            continue;
        }

        if (missingPaths.has(note.path)) {
            index.update(
                note.path,
                content,
                note.mtime,
            );

            missingRestored++;
        }

        onProgress?.(
            position + 1,
            authoritativeNotes.length,
        );
    }

    return {
        staleRemoved,
        missingRestored,
        missingUnreadable,
        verifiedNotes: authoritativeNotes.length,
    };
}
