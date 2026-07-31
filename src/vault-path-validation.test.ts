import assert from "node:assert/strict";
import { test } from "node:test";

import { validateVaultPath } from "./path-validation.js";

test("allows consecutive dots inside valid filenames", () => {
    assert.doesNotThrow(() =>
        validateVaultPath(
            "dailynotes/пятница, 31 июля 2026 г..md",
        ),
    );

    assert.doesNotThrow(() =>
        validateVaultPath("inbox/темп..md"),
    );

    assert.doesNotThrow(() =>
        validateVaultPath("folder/archive...md"),
    );
});

test("rejects actual parent-directory traversal segments", () => {
    assert.throws(
        () => validateVaultPath("../secret.md"),
        /Invalid path/,
    );

    assert.throws(
        () => validateVaultPath("folder/../secret.md"),
        /Invalid path/,
    );

    assert.throws(
        () =>
            validateVaultPath(
                String.raw`folder\..\secret.md`,
            ),
        /Invalid path/,
    );
});

test("retains absolute, NUL and length protections", () => {
    assert.throws(
        () => validateVaultPath("/absolute.md"),
        /Invalid path/,
    );

    assert.throws(
        () =>
            validateVaultPath(
                String.raw`\absolute.md`,
            ),
        /Invalid path/,
    );

    assert.throws(
        () => validateVaultPath("bad\0name.md"),
        /Invalid path/,
    );

    assert.throws(
        () =>
            validateVaultPath(
                `${"a".repeat(1001)}.md`,
            ),
        /Invalid path/,
    );
});

test("allows ordinary vault-relative paths", () => {
    assert.doesNotThrow(() =>
        validateVaultPath(
            "projects/homelab/overview.md",
        ),
    );

    assert.doesNotThrow(() =>
        validateVaultPath(
            "Заметки/Тестовая заметка.md",
        ),
    );
});
