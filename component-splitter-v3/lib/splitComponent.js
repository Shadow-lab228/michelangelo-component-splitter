const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const {
  parseSource, getText, lineCount, findAllJsxReturns, findIdentifierOccurrence,
  getMeaningfulChildren, collectBoundNames, collectUsedIdentifiers,
  collectJsxTagNames, collectOuterScopeNames, inferTypeFromDeclaration,
  KNOWN_RN_COMPONENTS, DEFAULT_OPTIONS,
} = require('./ast-helpers');
const { loadProgramForFile, getRealTypeStringAtPosition } = require('./project');
const { createStylesRegistry } = require('./styles-registry');
const { formatCode } = require('./format');
const { generateTestStub } = require('./testGenerator');

const V3_DEFAULTS = {
  ...DEFAULT_OPTIONS,
  withTests: false,
  sharedStyles: true,
  recursive: true,
  maxDepth: 2,
  format: true,
  selfCheck: true,
  backup: true,
};

// ---------- import copying (same approach as v2, with path adjustment) ----------

function findImportLineFor(sourceFile, fullText, name) {
  let found = null;
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    const names = [];
    if (clause.name) names.push(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) names.push(el.name.text);
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push(clause.namedBindings.name.text);
      }
    }
    if (names.includes(name)) {
      found = getText(stmt, fullText);
      break;
    }
  }
  return found;
}

function adjustImportForNestedLocation(importText) {
  return importText.replace(/(['"])(\.\.?\/[^'"]*)\1/, (whole, quote, spec) => {
    let adjusted;
    if (spec.startsWith('./')) adjusted = '../' + spec.slice(2);
    else if (spec.startsWith('../')) adjusted = '../' + spec;
    else adjusted = spec;
    return quote + adjusted + quote;
  });
}

const TS_BUILTIN_TYPE_NAMES = new Set([
  'Array', 'Promise', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
  'Date', 'RegExp', 'Error', 'Map', 'Set', 'String', 'Number', 'Boolean', 'Object', 'Function',
]);

/** Finds a local `interface X` or `type X = ...` declaration in the source
 * file, returning its full source text if found. */
function findLocalTypeDeclaration(sourceFile, fullText, name) {
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return getText(stmt, fullText);
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return getText(stmt, fullText);
  }
  return null;
}

/** Given an inferred type string (e.g. "Post[]", "Record<string, Post>"),
 * pulls out capitalized type-reference names that aren't TS builtins, so we
 * can make sure the new file actually has access to them (either by
 * copying a local type declaration, or copying + path-adjusting the import
 * that provides it). Returns { extraDecls: string[], extraImports: string[] }. */
function resolveTypeDependencies(sourceFile, fullText, typeString) {
  const names = [...new Set((typeString.match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []))]
    .filter((n) => !TS_BUILTIN_TYPE_NAMES.has(n));

  const extraDecls = [];
  const extraImports = [];
  const unresolved = [];

  for (const name of names) {
    const localDecl = findLocalTypeDeclaration(sourceFile, fullText, name);
    if (localDecl) {
      extraDecls.push(localDecl);
      continue;
    }
    const importLine = findImportLineFor(sourceFile, fullText, name);
    if (importLine) {
      extraImports.push(adjustImportForNestedLocation(importLine));
      continue;
    }
    unresolved.push(name);
  }

  return { extraDecls, extraImports, unresolved };
}

function detectUsedRNComponents(text) {
  return [...KNOWN_RN_COMPONENTS].filter((name) => new RegExp(`<${name}[\\s/>]`).test(text));
}

function toPascalCase(str) {
  return str.split(/[\s_-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

function guessComponentName(childNode, fullText, precedingCommentText, index) {
  if (precedingCommentText) {
    const m = precedingCommentText.match(/\{\s*\/\*\s*([A-Za-z][A-Za-z0-9 ]*)\s*\*\/\s*\}/);
    if (m) return toPascalCase(m[1]) + 'Section';
  }
  const text = getText(childNode, fullText);
  const testIdMatch = text.match(/testID=["'`]([\w-]+)["'`]/);
  if (testIdMatch) return toPascalCase(testIdMatch[1].replace(/[-_]/g, ' '));
  const tagMatch = text.match(/<([A-Za-z][A-Za-z0-9.]*)/);
  if (tagMatch) return toPascalCase(tagMatch[1].split('.').pop()) + 'Block' + index;
  return 'ExtractedBlock' + index;
}

function dedent(text) {
  const lines = text.split('\n');
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => l.match(/^ */)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l.length >= min ? l.slice(min) : l)).join('\n');
}

function indentText(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((l) => (l.trim().length ? pad + l : l)).join('\n');
}

/** Extracts style={{...}} into named references, routing through a shared
 * registry when enabled so identical styles across the project are deduped. */
function extractStylesFromText(text, namePrefix, sharedRegistry) {
  const localStyles = [];
  let out = '';
  let i = 0;
  let counter = 0;
  const seen = new Map();

  while (i < text.length) {
    const marker = 'style={{';
    if (text.startsWith(marker, i)) {
      const contentStart = i + marker.length - 1;
      let depth = 0;
      let j = contentStart;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) break; }
      }
      const objectText = text.slice(contentStart, j + 1);
      const afterObject = j + 1;
      const closing = text[afterObject] === '}' ? afterObject + 1 : afterObject;

      if (sharedRegistry) {
        const sharedName = sharedRegistry.getOrCreate(objectText);
        out += `style={sharedStyles.${sharedName}}`;
      } else {
        let name;
        if (seen.has(objectText)) name = seen.get(objectText);
        else {
          counter += 1;
          name = `${namePrefix}${counter}`;
          seen.set(objectText, name);
          localStyles.push({ name, objectText });
        }
        out += `style={styles.${name}}`;
      }
      i = closing;
      continue;
    }
    out += text[i];
    i++;
  }
  return { text: out, localStyles };
}

/** Restores files from a backup map if self-check fails. */
function rollback(backups, newFiles) {
  for (const [filePath, content] of backups.entries()) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  for (const f of newFiles) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/**
 * Runs a real type-check pass restricted to the files this run touched,
 * and reports which of them have syntax errors (always blocking) or
 * "broken reference" semantic errors (cannot find name / module — usually
 * means we generated something wrong, e.g. a bad prop or import).
 */
function selfCheck(projectInfo, touchedFilePaths) {
  const problems = [];
  if (!projectInfo) return { ok: true, problems, skipped: true };

  // Re-create the program fresh so it picks up the files we just wrote.
  const program = ts.createProgram(
    [...new Set([...program_root_names(projectInfo), ...touchedFilePaths])],
    projectInfo.program.getCompilerOptions()
  );

  for (const filePath of touchedFilePaths) {
    const sf = program.getSourceFile(filePath);
    if (!sf) continue;
    const syntactic = program.getSyntacticDiagnostics(sf);
    if (syntactic.length) {
      problems.push({ file: filePath, kind: 'syntax', diagnostics: syntactic.map(formatDiagnostic) });
      continue;
    }
    const semantic = program.getSemanticDiagnostics(sf);
    const blocking = semantic.filter((d) => d.code === 2304 || d.code === 2307); // cannot find name / module
    if (blocking.length) {
      problems.push({ file: filePath, kind: 'reference', diagnostics: blocking.map(formatDiagnostic) });
    }
  }

  return { ok: problems.length === 0, problems };
}

function program_root_names(projectInfo) {
  return projectInfo.program.getRootFileNames();
}

function formatDiagnostic(d) {
  return ts.flattenDiagnosticMessageText(d.messageText, '\n');
}

// ---------- main entry point ----------

function splitComponentFile(filePath, userOptions = {}, _depth = 0) {
  const options = { ...V3_DEFAULTS, ...userOptions };
  const { sourceFile, text } = parseSource(filePath);

  const report = {
    file: filePath, totalLines: text.split('\n').length,
    extracted: [], skippedReason: null, rolledBack: false, nested: [],
  };

  const allReturns = findAllJsxReturns(sourceFile);
  if (allReturns.length === 0) {
    report.skippedReason = 'Could not locate any component function that returns JSX.';
    return report;
  }

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const outputDir = options.outputDir || path.join(dir, 'components');
  const stylesFilePath = path.join(dir, 'styles', 'shared.ts');
  const testsDir = path.join(outputDir, '__tests__');

  const projectInfo = loadProgramForFile(filePath);
  const sharedRegistry = options.sharedStyles ? createStylesRegistry(stylesFilePath) : null;

  const usedNames = new Set();
  const importLines = [];
  const textReplacements = [];
  const newFilesWritten = [];
  let extractIndex = 1;
  let anyExtracted = false;

  for (const { functionNode, rootJsx } of allReturns) {
    const bodyLineCount = lineCount(rootJsx, text);
    if (bodyLineCount < options.maxComponentLines) continue;

    const children = getMeaningfulChildren(rootJsx);
    const outerScopeNames = collectOuterScopeNames(sourceFile, functionNode);
    const candidates = children
      .map((child) => ({ child, lines: lineCount(child, text) }))
      .filter((c) => c.lines >= options.minBlockLinesToExtract);

    if (candidates.length < 2) continue;
    anyExtracted = true;

    for (const candidate of candidates) {
      const { child } = candidate;
      const childIdxInAll = children.indexOf(child);
      const precedingText = childIdxInAll > 0 ? getText(children[childIdxInAll - 1], text) : '';

      let name = guessComponentName(child, text, precedingText, extractIndex);
      while (usedNames.has(name)) { extractIndex += 1; name = guessComponentName(child, text, precedingText, extractIndex); }
      usedNames.add(name);
      extractIndex += 1;

      const used = collectUsedIdentifiers(child);
      const bound = collectBoundNames(child);
      const freeNames = [...used].filter((n) => !bound.has(n));
      const propNames = freeNames.filter((n) => outerScopeNames.has(n));

      const propTypes = propNames.map((p) => {
        let type = null;
        let usedRealInference = false;
        if (projectInfo) {
          const occurrence = findIdentifierOccurrence(child, p);
          if (occurrence) {
            const programSourceFile = projectInfo.program.getSourceFile(filePath);
            if (programSourceFile) {
              type = getRealTypeStringAtPosition(projectInfo.checker, programSourceFile, occurrence.getStart());
              if (type) usedRealInference = true;
            }
          }
        }
        if (!type) type = inferTypeFromDeclaration(sourceFile, functionNode, p);
        return { name: p, type, usedRealInference };
      });

      // Make sure any custom type names the inferred types reference are
      // actually available in the new file — copy local type/interface
      // declarations or their import, or fall back to `any` if we can't
      // resolve them (safer than emitting a reference to nothing).
      const extraTypeDecls = [];
      const extraTypeImports = [];
      for (const pt of propTypes) {
        if (!pt.usedRealInference) continue;
        const { extraDecls, extraImports, unresolved } = resolveTypeDependencies(sourceFile, text, pt.type);
        if (unresolved.length) {
          pt.type = 'any'; // couldn't safely resolve a dependency; don't risk a broken reference
          continue;
        }
        extraTypeDecls.push(...extraDecls);
        extraTypeImports.push(...extraImports);
      }

      const tagNames = collectJsxTagNames(child);
      const customTags = [...tagNames].filter((t) => !KNOWN_RN_COMPONENTS.has(t));
      const customImportLines = customTags
        .map((t) => findImportLineFor(sourceFile, text, t))
        .filter(Boolean)
        .map(adjustImportForNestedLocation);

      const rawChildText = getText(child, text);
      const dedented = dedent(rawChildText);
      const { text: styledText, localStyles } = options.extractStyles !== false
        ? extractStylesFromText(dedented, 'style', sharedRegistry)
        : { text: dedented, localStyles: [] };

      const rnComponents = detectUsedRNComponents(styledText);
      const needsLocalStyleSheet = localStyles.length > 0;
      const needsSharedStylesImport = sharedRegistry && styledText.includes('sharedStyles.');

      const propsDestructure = propTypes.length ? `{ ${propTypes.map((p) => p.name).join(', ')} }` : '';
      const propsTypeBlock = propTypes.length
        ? `type ${name}Props = {\n${propTypes.map((p) => `  ${p.name}: ${p.type};`).join('\n')}\n};\n\n`
        : '';
      const propsAnnotation = propTypes.length ? `: ${name}Props` : '';
      const rnImportList = [...rnComponents, ...(needsLocalStyleSheet ? ['StyleSheet'] : [])];

      const sharedStylesImportPath = path.relative(outputDir, path.join(dir, 'styles', 'shared')).replace(/\\/g, '/');
      const sharedStylesImport = needsSharedStylesImport
        ? `import { sharedStyles } from '${sharedStylesImportPath.startsWith('.') ? sharedStylesImportPath : './' + sharedStylesImportPath}';\n`
        : '';

      let componentFileContent = `import React from 'react';
${rnImportList.length ? `import { ${rnImportList.join(', ')} } from 'react-native';\n` : ''}${sharedStylesImport}${customImportLines.join('\n')}${customImportLines.length ? '\n' : ''}${extraTypeImports.join('\n')}${extraTypeImports.length ? '\n' : ''}
${extraTypeDecls.length ? extraTypeDecls.join('\n\n') + '\n\n' : ''}${propsTypeBlock}export default function ${name}(${propsDestructure}${propsAnnotation}) {
  return (
${indentText(styledText, 4)}
  );
}
${needsLocalStyleSheet ? `\nconst styles = StyleSheet.create({\n${localStyles.map((s) => `  ${s.name}: ${s.objectText},`).join('\n')}\n});\n` : ''}`;

      if (options.format) componentFileContent = formatCode(componentFileContent, `${name}.tsx`);

      const componentFilePath = path.join(outputDir, `${name}${ext}`);
      const entry = {
        name, props: propTypes, linesExtracted: candidate.lines,
        localStylesExtracted: localStyles.length,
        customImports: customImportLines, newFile: componentFilePath, content: componentFileContent,
      };

      if (options.withTests) {
        const testImportPath = path.relative(testsDir, componentFilePath).replace(/\.tsx?$/, '').replace(/\\/g, '/');
        entry.testFile = path.join(testsDir, `${name}.test.tsx`);
        entry.testContent = generateTestStub(name, propTypes, testImportPath.startsWith('.') ? testImportPath : './' + testImportPath);
      }

      report.extracted.push(entry);
      importLines.push(`import ${name} from './components/${name}';`);

      const propsAttrsUsage = propTypes.map((p) => `${p.name}={${p.name}}`).join(' ');
      textReplacements.push({
        start: child.getStart(), end: child.getEnd(),
        replacement: `<${name}${propsAttrsUsage ? ' ' + propsAttrsUsage : ''} />`,
      });
    }
  }

  if (!anyExtracted) {
    report.skippedReason = 'No return branch had enough large top-level sibling JSX blocks to justify splitting.';
    return report;
  }

  textReplacements.sort((a, b) => b.start - a.start);
  let newText = text;
  for (const r of textReplacements) newText = newText.slice(0, r.start) + r.replacement + newText.slice(r.end);

  const lastImport = [...sourceFile.statements].reverse().find((s) => ts.isImportDeclaration(s));
  const insertPos = lastImport ? lastImport.getEnd() : 0;
  newText = newText.slice(0, insertPos) + '\n' + importLines.join('\n') + newText.slice(insertPos);
  if (options.format) newText = formatCode(newText, path.basename(filePath));

  report.rewrittenOriginal = newText;
  report.outputDir = outputDir;

  if (options.dryRun) return report;

  // ---- write everything, with backup + self-check ----
  const backups = new Map();
  if (options.backup) {
    backups.set(filePath, text);
    fs.writeFileSync(`${filePath}.bak`, text, 'utf8');
  }

  fs.mkdirSync(outputDir, { recursive: true });
  if (options.withTests) fs.mkdirSync(testsDir, { recursive: true });

  for (const e of report.extracted) {
    fs.writeFileSync(e.newFile, e.content, 'utf8');
    newFilesWritten.push(e.newFile);
    if (e.testFile) {
      fs.writeFileSync(e.testFile, e.testContent, 'utf8');
      newFilesWritten.push(e.testFile);
    }
  }
  fs.writeFileSync(filePath, newText, 'utf8');
  if (sharedRegistry) sharedRegistry.save();

  if (options.selfCheck && projectInfo) {
    const touched = [filePath, ...report.extracted.map((e) => e.newFile)];
    const result = selfCheck(projectInfo, touched);
    report.selfCheck = result;
    if (!result.ok) {
      rollback(backups, newFilesWritten);
      report.rolledBack = true;
      return report;
    }
  } else {
    report.selfCheck = { ok: true, skipped: true };
  }

  // ---- recursion: if an extracted component is itself still too big, split it too ----
  if (options.recursive && _depth < options.maxDepth) {
    for (const e of report.extracted) {
      const nestedLines = e.content.split('\n').length;
      if (nestedLines >= options.maxComponentLines) {
        const nestedReport = splitComponentFile(e.newFile, options, _depth + 1);
        report.nested.push(nestedReport);
      }
    }
  }

  return report;
}

module.exports = { splitComponentFile };
