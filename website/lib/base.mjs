// The path a site is published under, as the build and the preview server both take it: "/" for the root of a
// host, "/vigile/" for a project's path, "/a/b/" for a deeper one. It starts and ends with a slash; one that is
// given without its last slash gets it. Anything that is not a plain path is refused, because the path is
// written into links and into the addresses the server sends a browser on to: two slashes at its start would
// lead to another host.

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The base path in its one form, or an Error that says what is wrong with what was given. */
export function basePath(given) {
  if (typeof given !== "string" || !given.startsWith("/")) throw new Error(`The base path "${given}" has to start with a slash, as in /vigile/.`);
  const path = given.endsWith("/") ? given : `${given}/`;
  if (path === "/") return path;
  for (const segment of path.slice(1, -1).split("/")) {
    if (segment === "" || segment === "." || segment === ".." || !SEGMENT.test(segment)) {
      throw new Error(`The base path "${given}" is not a plain path. It is made of names of letters, digits, ".", "_", "~" and "-", with one slash between them, as in /vigile/ or /docs/vigile/.`);
    }
  }
  return path;
}
