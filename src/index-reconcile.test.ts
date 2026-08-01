import test from "node:test";
import assert from "node:assert/strict";

import {
    diffIndexPaths,
    reconcileIndexPaths,
    type IndexedNotePath,
} from "./index-reconcile.js";

test("detects stale persisted paths", () => {
    const result = diffIndexPaths(
        [
            { path: "active.md", mtime: 1 },
            { path: "deleted.md", mtime: 2 },
        ],
        [
            { path: "active.md", mtime: 1 },
        ],
    );

    assert.deepEqual(
        result.stalePaths,
        ["deleted.md"],
    );

    assert.deepEqual(
        result.missingNotes,
        [],
    );
});

test("detects notes missing from the persisted index", () => {
    const result = diffIndexPaths(
        [
            { path: "existing.md", mtime: 1 },
        ],
        [
            { path: "existing.md", mtime: 1 },
            { path: "folder/new..note.md", mtime: 2 },
        ],
    );

    assert.deepEqual(
        result.stalePaths,
        [],
    );

    assert.deepEqual(
        result.missingNotes,
        [
            {
                path: "folder/new..note.md",
                mtime: 2,
            },
        ],
    );
});

test(
    "removes unreadable indexed entries and restores readable missing notes",
    async () => {
        const stored =
            new Map<string, {
                content: string;
                mtime: number;
            }>([
                [
                    "active.md",
                    {
                        content: "old active",
                        mtime: 1,
                    },
                ],
                [
                    "ghost.md",
                    {
                        content: "stale",
                        mtime: 2,
                    },
                ],
                [
                    "deleted.md",
                    {
                        content: "deleted",
                        mtime: 3,
                    },
                ],
            ]);

        const removed: string[] = [];

        const updated: Array<{
            path: string;
            content: string;
            mtime?: number;
        }> = [];

        const index = {
            listWithMtime(): IndexedNotePath[] {
                return [...stored.entries()].map(
                    ([path, value]) => ({
                        path,
                        mtime: value.mtime,
                    }),
                );
            },

            update(
                path: string,
                content: string,
                mtime?: number,
            ): void {
                updated.push({
                    path,
                    content,
                    mtime,
                });

                stored.set(path, {
                    content,
                    mtime: mtime ?? 0,
                });
            },

            remove(path: string): void {
                removed.push(path);
                stored.delete(path);
            },
        };

        const contents =
            new Map<string, string | null>([
                ["active.md", "active"],
                ["ghost.md", null],
                ["new.md", "new"],
                ["empty.md", null],
                ["missing.md", null],
            ]);

        const metadataPresent =
            new Set([
                "active.md",
                "new.md",
                "empty.md",
            ]);

        const progress: Array<[number, number]> = [];

        const result = await reconcileIndexPaths(
            index,
            {
                async readNote(path) {
                    return contents.get(path) ?? null;
                },

                async getMetadata(path) {
                    return metadataPresent.has(path)
                        ? { path }
                        : null;
                },
            },
            [
                { path: "active.md", mtime: 10 },
                { path: "ghost.md", mtime: 20 },
                { path: "new.md", mtime: 30 },
                { path: "empty.md", mtime: 40 },
                { path: "missing.md", mtime: 50 },
            ],
            (processed, total) => {
                progress.push([processed, total]);
            },
        );

        assert.deepEqual(result, {
            staleRemoved: 2,
            missingRestored: 2,
            missingUnreadable: 1,
            verifiedNotes: 5,
        });

        assert.deepEqual(
            removed.sort(),
            [
                "deleted.md",
                "ghost.md",
            ],
        );

        assert.deepEqual(
            updated,
            [
                {
                    path: "empty.md",
                    content: "",
                    mtime: 40,
                },
                {
                    path: "new.md",
                    content: "new",
                    mtime: 30,
                },
            ],
        );

        assert.deepEqual(
            progress.at(-1),
            [5, 5],
        );
    },
);

test("returns an empty diff for matching path sets", () => {
    const result = diffIndexPaths(
        [
            { path: "a.md", mtime: 1 },
            { path: "folder/b.md", mtime: 2 },
        ],
        [
            { path: "folder/b.md", mtime: 2 },
            { path: "a.md", mtime: 1 },
        ],
    );

    assert.deepEqual(result, {
        stalePaths: [],
        missingNotes: [],
    });
});
