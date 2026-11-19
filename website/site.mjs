// The shape of the site: its three areas, the order of the pages in each, and how the operations are grouped.
// A page that is not listed here, or a listed page that does not exist, stops the build.

/**
 * Where the site is published. Every link inside the site is relative, so the site works under any path; this
 * address is only for what must be absolute: the sitemap, the canonical address and the picture of a shared
 * link, and the links of the 404 page, which GitHub Pages serves at any depth. Set SITE_URL to change it, for
 * example to another domain: SITE_URL=https://vigile.example/ node website/build.mjs
 */
export const SITE_URL = withSlash(process.env.SITE_URL || "https://vigile.dev.ai/");

/** Where the code is, for the links to the source and for the command that fetches it. */
export const REPO_URL = (process.env.REPO_URL || "https://github.com/dluc/vigile").replace(/\/$/, "");

function withSlash(address) {
  return address.endsWith("/") ? address : `${address}/`;
}

export const AREAS = [
  { id: "product", title: "Product", path: "", says: "What Vigile is for, what it does today, and where it could go" },
  { id: "how", title: "How it works", path: "how/", says: "The ideas, one at a time, each with a picture" },
  { id: "docs", title: "Documentation", path: "docs/", says: "Install it, run it, and the reference for every part" },
];

export const NAV = {
  product: [{ pages: ["", "vision/"] }],
  how: [
    { pages: ["how/"] },
    { title: "The plan", pages: ["how/plan-as-a-graph/", "how/statuses/", "how/next-and-waiting/", "how/versions-and-history/", "how/problems/"] },
    { title: "The service", pages: ["how/users-and-access/", "how/interfaces/", "how/storage/", "how/one-service/"] },
  ],
  docs: [
    { pages: ["docs/"] },
    { title: "Start", pages: ["docs/install/", "docs/web-page/"] },
    { title: "Interfaces", pages: ["docs/cli/", "docs/http-api/", "docs/mcp/"] },
    { title: "Reference", pages: ["docs/operations/", "docs/model/", "docs/errors/", "docs/configuration/", "docs/guide/"] },
    { title: "Running it", pages: ["docs/storage/", "docs/security/", "docs/troubleshooting/"] },
  ],
};

/** The operations as the documentation groups them. Every operation is in one group. */
export const OPERATION_GROUPS = [
  { title: "Projects", operations: ["create_project", "set_project_status", "list_projects"] },
  { title: "Tasks", operations: ["create_task", "update_task", "set_task_status", "list_tasks", "list_next_tasks", "list_stale_tasks"] },
  { title: "Any item", operations: ["get", "list_history", "delete", "restore", "override_timestamp"] },
  { title: "Links", operations: ["add_link", "remove_link", "list_link_types"] },
  { title: "Users", operations: ["list_users", "create_user", "reset_user_key"] },
  { title: "The guide", operations: ["get_guide"] },
];
