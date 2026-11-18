import type { Readable } from "node:stream";

/**
 * The body of a request as text, for every interface that takes one over HTTP, or null when it is larger than
 * `most` bytes, whatever the request said of its size. Fails when the caller leaves before all of it is here.
 *
 * It is kept in one piece that grows with what has come, never as the pieces it came in: a body can be sent a
 * byte at a time, and a million pieces of a byte each would cost a hundred times what they hold. The piece
 * begins small whatever the request says of its size: room is made for what is here, not for what a request
 * announces and may never send.
 *
 * A body that grows past `most` is not taken in any further and is not let go either: the request stands
 * still, so that whoever answers can say why, and end the connection with that answer.
 */
export function readBody(request: Readable, most: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let held = Buffer.allocUnsafe(Math.min(most, 16 * 1024));
    let size = 0;
    // Once it is known how the reading ended, nothing of it is kept: the request may live on for as long as
    // its answer takes, and would otherwise hold what was read for all that time.
    const over = (): void => {
      request.off("data", take);
      request.off("end", ended);
      request.off("error", failed);
      request.off("close", closed);
      held = Buffer.alloc(0);
    };
    const take = (chunk: Buffer): void => {
      const grown = size + chunk.length;
      if (grown <= most) {
        if (grown > held.length) {
          const larger = Buffer.allocUnsafe(Math.min(most, Math.max(grown, held.length * 2)));
          held.copy(larger, 0, 0, size);
          held = larger;
        }
        chunk.copy(held, size);
        size = grown;
        return;
      }
      request.pause();
      over();
      resolve(null);
    };
    const ended = (): void => {
      const text = held.toString("utf8", 0, size);
      over();
      resolve(text);
    };
    const failed = (error: unknown): void => {
      over();
      reject(error);
    };
    // A request that ends without having said so: its caller left.
    const closed = (): void => failed(new Error("The request was closed before all of it had arrived."));
    request.on("data", take);
    request.once("end", ended);
    request.once("error", failed);
    request.once("close", closed);
  });
}
