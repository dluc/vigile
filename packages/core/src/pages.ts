import { ENDS, NotAList, PAGED, describeList, isPaged, readToEnd } from "./paging.js";

/**
 * Reads a list to its end, page by page: for those who need every entry, such as the service at its start,
 * which checks that each key in the config belongs to a user. `call` runs an operation with the input it is
 * given; `operation` is the list operation, `input` its filters, and `who` the ID of the user it is asked as,
 * where the list is that user's own.
 *
 * The list is read by the steps that hold for whoever reads one (`takePage` in `paging.ts`): a token is sent on
 * once, and only a token of this very list, after a page whose entries are all further on in the list. It is
 * read for at most a thousand pages and a hundred thousand entries. A list that is not so is no list of the
 * operation, and reading it ends with that said, before anything more is asked for.
 */
export async function readAll<T = any>(call: (operation: string, input: Record<string, unknown>) => Promise<unknown>, operation: string, input: Record<string, unknown> = {}, who?: string): Promise<T[]> {
  if (!isPaged(operation)) throw new Error(`${operation} returns no list that is read page by page.`);
  const field = PAGED[operation];
  try {
    return await readToEnd<T>(describeList(operation, input, who), async (continuation) => {
      const page = await call(operation, { ...input, ...(continuation === undefined ? {} : { continuation }) });
      const answer: Record<string, unknown> = typeof page === "object" && page !== null ? (page as Record<string, unknown>) : {};
      return { entries: answer[field], continuation: Object.hasOwn(answer, "continuation") ? answer.continuation : ENDS };
    });
  } catch (error) {
    if (error instanceof NotAList) throw new Error(`${operation} did not answer as its list does: ${error.why}.`);
    throw error;
  }
}
