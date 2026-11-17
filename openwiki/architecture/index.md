# Files

- [Architecture overview](overview.md) - How the Hudu MCP server boots, chooses between stdio and streamable HTTP, builds a per-request MCP server and Hudu client, registers tools, and shuts down.
- [Tool surface and dispatch](tool-surface.md) - The MCP tools the server registers, how the read/write/delete dispatchers wrap the SDK, how list, fetch-many and context reads are shaped, and how results and errors are normalised.
