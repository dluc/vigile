/**
 * No request of the command line follows a redirect: the key and what is asked are for the address the config
 * names, and an answer from anywhere else is not the service's. Every request is made with `redirect: "manual"`,
 * and a redirect that comes back is said to be one. Returns how to say it, or nothing for any other answer.
 */
export function redirectOf(response: Response): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  // Where it points is whatever answered chose: shown as one short line of plain characters.
  const onward = response.headers.get("location")?.replace(/[^\x21-\x7e]/g, "?").slice(0, 200);
  return `a redirect (${response.status})${onward ? ` to ${onward}` : ""}, which the command line does not follow`;
}
