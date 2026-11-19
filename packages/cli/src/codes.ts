/**
 * What a failure of the command line itself is called: one that the service did not answer with, because it was
 * not asked, was not reached, or did not answer. The service's own errors keep the codes the service gives them.
 */
export const COMMAND_LINE_CODES = ["usage", "config_invalid", "config_busy", "cannot_start", "not_running", "not_this_service", "no_answer", "failed"] as const;
export type CommandLineCode = (typeof COMMAND_LINE_CODES)[number];

/**
 * What the command ends with. 1 is every failure after which nothing was done. 2 is the one after which that is
 * not known: the service was reached and its answer did not come, so a change may have been stored, may be
 * stored yet, or never, and a script must not take it for any of them.
 */
export const EXIT_CODES = { done: 0, failed: 1, no_answer: 2 } as const;
