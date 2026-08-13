/** Local ambient declarations for test-only APIs.
 *
 *  Deliberately hand-written rather than pulling in @types/node: the tests use
 *  a tiny slice of node:sqlite, and adding a dependency to type four methods
 *  would not earn its place in a four-dependency project. If the surface used
 *  here grows much beyond this, revisit that trade-off. */

/** Raw file import, handled by Vite. Used to load the SQL migration into the
 *  schema test without needing node:fs. */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

/** Raw file import, handled by Vite. Used to load public/sw.js and
 *  public/site.webmanifest into the PWA tests. The service worker is a classic
 *  (non-module) script served verbatim from public/, so it cannot be imported
 *  normally; the test evaluates the real file rather than a re-typed copy. */
declare module '*.js?raw' {
  const content: string;
  export default content;
}

declare module '*.webmanifest?raw' {
  const content: string;
  export default content;
}

/** The subset of node:sqlite the migration test uses.
 *
 *  Unflagged from Node 23.4; needs --experimental-sqlite on Node 22. The test
 *  probes for availability at runtime and skips rather than failing, so this
 *  declaration existing does not imply the module is present. */
declare module 'node:sqlite' {
  export interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
