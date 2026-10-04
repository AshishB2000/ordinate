// pdfmake 0.3 ships no types: the two browser bundles the PDF writer imports,
// typed as far as ./pdf.ts uses them.

declare module 'pdfmake/build/pdfmake' {
  interface OutputDocument {
    getBlob(): Promise<Blob>;
    getBuffer(): Promise<Uint8Array>;
  }
  const pdfMake: {
    addVirtualFileSystem(vfs: Record<string, string>): void;
    createPdf(doc: Record<string, unknown>): OutputDocument;
  };
  export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts' {
  const vfs: Record<string, string>;
  export default vfs;
}
