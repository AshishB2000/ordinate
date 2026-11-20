// What a parse says, shared by the worker thread and the main thread. PURE.

/** Why a file was not read. The main thread words each one (./knowledgeMessages). */
export type ReadFailure = 'type' | 'utf8' | 'encrypted' | 'noText' | 'zipBomb' | 'tooLong' | 'unreadable' | 'timeout' | 'memory' | 'busy';

export class ParseError extends Error {
  constructor(readonly code: ReadFailure) {
    super(code);
    this.name = 'ParseError';
  }
}

export type DocSource = 'typed' | 'markdown' | 'text' | 'pdf' | 'docx';

export interface Parsed {
  source: Exclude<DocSource, 'typed'>;
  text: string;
}
