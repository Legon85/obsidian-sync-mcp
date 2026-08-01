import test from "node:test";
import assert from "node:assert/strict";
import { diffIndexPaths } from "./index-reconcile.js";

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

    assert.deepEqual(result.stalePaths, ["deleted.md"]);
    assert.deepEqual(result.missingNotes, []);
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

    assert.deepEqual(result.stalePaths, []);
    assert.deepEqual(result.missingNotes, [
        { path: "folder/new..note.md", mtime: 2 },
    ]);
});

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
