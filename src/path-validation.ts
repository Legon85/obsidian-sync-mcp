export function validateVaultPath(path: string): void {
    if (!path || path.includes("\0") || path.length > 1000) {
        throw new Error("Invalid path");
    }

    const normalizedPath = path.replaceAll("\\", "/");
    const pathSegments = normalizedPath.split("/");

    if (
        normalizedPath.startsWith("/") ||
        pathSegments.includes("..")
    ) {
        throw new Error("Invalid path");
    }
}
