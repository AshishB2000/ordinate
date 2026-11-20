// What a knowledge document may hold (docs/knowledge-docs/00-design.md, "Limits"). PURE: constants only.

export const MAX_DOCS_PER_PROJECT = 100; // its own and every agent's together
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 300_000;
export const MAX_TITLE = 120;
export const MAX_PASSAGE_CHARS = 800;
export const MAX_ASK_PASSAGES = 6;
export const MAX_ASK_CHARS = 4000;
/** A .docx entry may inflate to this much before it is refused (a zip bomb). */
export const MAX_DOCX_XML_BYTES = 50 * 1024 * 1024;
/** A parse worker gets this long, then it is terminated. */
export const PARSE_TIMEOUT_MS = 30_000;
/** The child process that reads a file is killed past this much resident memory (src/knowledge/parseChild.ts). */
export const PARSE_MEMORY_MB = 256;
/** Parses running at once per pod; more wait. */
export const PARSE_CONCURRENCY = 2;
/** The exit code of a child that went past its memory budget. */
export const EXIT_MEMORY = 87;
