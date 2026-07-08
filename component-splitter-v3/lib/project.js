const fs = require('fs');
const path = require('path');
const ts = require('typescript');

/** Finds the nearest tsconfig.json walking upward from a file's directory. */
function findTsConfig(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Loads a real ts.Program for the project containing `filePath`, if a
 * tsconfig.json can be found. Returns null if not (caller should fall back
 * to heuristic-only mode). */
function loadProgramForFile(filePath) {
  const configPath = findTsConfig(path.dirname(filePath));
  if (!configPath) return null;

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return null;

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
  );

  const rootNames = parsed.fileNames.includes(filePath)
    ? parsed.fileNames
    : [...parsed.fileNames, filePath];

  const program = ts.createProgram(rootNames, parsed.options);
  const checker = program.getTypeChecker();
  return { program, checker, configPath, projectRoot: path.dirname(configPath) };
}

/** Finds the most specific (deepest) node at a given character offset within
 * a source file — used to map a position from our independently-parsed AST
 * (from ast-helpers.parseSource) onto the Program's own internal AST, since
 * ts.TypeChecker only resolves nodes that belong to its own Program. */
function findNodeAtPosition(sourceFile, pos) {
  let result = sourceFile;
  function visit(node) {
    if (pos >= node.getStart() && pos < node.getEnd()) {
      result = node;
      ts.forEachChild(node, visit);
    }
  }
  visit(sourceFile);
  return result;
}

/** Given a real type checker + the Program's own source file for the file
 * being analyzed, plus a character position (taken from our separately
 * parsed AST — see findNodeAtPosition above for why this indirection is
 * needed), returns a clean, printable type string. Returns null if it
 * can't resolve a meaningful type (e.g. resolves to `any`/`error`). */
function getRealTypeStringAtPosition(checker, programSourceFile, pos) {
  try {
    const node = findNodeAtPosition(programSourceFile, pos);
    if (!ts.isIdentifier(node)) return null;
    const type = checker.getTypeAtLocation(node);
    const typeString = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
    if (!typeString || typeString === 'any' || typeString === 'unknown') return null;
    return typeString;
  } catch {
    return null;
  }
}

module.exports = { findTsConfig, loadProgramForFile, getRealTypeStringAtPosition, findNodeAtPosition };
