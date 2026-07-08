const ts = require('typescript');

/**
 * Reformats a full source-file's worth of generated code by parsing it and
 * re-emitting it through the TypeScript printer. This gives consistent
 * indentation regardless of how the raw text-splicing left things, without
 * needing a real formatter dependency (Prettier isn't installed here).
 *
 * Note: this is NOT Prettier — semicolon/quote style etc. follow the
 * printer's defaults, not the project's own style. Good enough to make
 * output readable; a project that cares about exact style should run its
 * own formatter over the result afterward.
 */
function formatCode(text, fileName = 'generated.tsx') {
  try {
    const sourceFile = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TSX
    );
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return printer.printFile(sourceFile);
  } catch {
    // If anything goes wrong reformatting, fall back to the original text
    // rather than losing the content.
    return text;
  }
}

module.exports = { formatCode };
