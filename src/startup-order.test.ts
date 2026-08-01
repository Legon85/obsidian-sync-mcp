import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test(
    "initial reconciliation completes before CouchDB watcher and MCP server",
    async () => {
        const source = await readFile(
            new URL("./main.ts", import.meta.url),
            "utf8",
        );

        const rebuild =
            source.indexOf("await rebuildIndex();");

        const watcher =
            source.indexOf("vault.watchChanges(");

        const server =
            source.indexOf(
                "const server = new FastMCP(serverOptions);",
            );

        assert.notEqual(
            rebuild,
            -1,
            "awaited initial rebuild is missing",
        );

        assert.notEqual(
            watcher,
            -1,
            "CouchDB watcher registration is missing",
        );

        assert.notEqual(
            server,
            -1,
            "MCP server construction is missing",
        );

        assert.ok(
            rebuild < watcher,
            "watcher must start only after reconciliation",
        );

        assert.ok(
            rebuild < server,
            "MCP server must start only after reconciliation",
        );

        assert.equal(
            source.includes("rebuildIndex().catch"),
            false,
            "fire-and-forget rebuild must not return",
        );
    },
);
