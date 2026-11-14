/**
 * Operation names use underscores in core and MCP, and hyphens in HTTP addresses and CLI commands.
 * Names hold only lowercase letters and underscores, so the swap is reversible.
 */
export const toHyphens = (name: string): string => name.replaceAll("_", "-");

export const toUnderscores = (name: string): string => name.replaceAll("-", "_");
