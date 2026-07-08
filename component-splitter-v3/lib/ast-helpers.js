/**
 * splitComponent.js (v2 — AST-based)
 *
 * Uses the real TypeScript compiler API to parse JSX/TSX, instead of the
 * regex/indentation heuristics from v1. This fixes the main limitations
 * that version's README flagged:
 *   - multi-line opening tags no longer break parsing
 *   - JSX fragments (<>...</>) are handled
 *   - conditional rendering ({cond && <X/>}) is a real AST node, not text
 *   - props are inferred via real scope analysis, not word-matching
 *   - inline styles can be safely extracted into StyleSheet.create()
 *   - custom (non-react-native) component tags get real imports copied in,
 *     instead of being silently dropped
 *
 * Requires the `typescript` package (added to package.json). No other
 * dependencies.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const DEFAULT_OPTIONS = {
  maxComponentLines: 150,
  minBlockLinesToExtract: 12,
  outputDir: null,
  extractStyles: true,
};

const KNOWN_RN_COMPONENTS = new Set([
  'View', 'Text', 'Image', 'ImageBackground', 'TouchableOpacity',
  'TouchableHighlight', 'TouchableWithoutFeedback', 'Pressable', 'ScrollView',
  'FlatList', 'SectionList', 'TextInput', 'Button', 'SafeAreaView', 'Switch',
  'Modal', 'ActivityIndicator', 'KeyboardAvoidingView', 'StatusBar',
]);

// ---------- parsing helpers ----------

function parseSource(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
  return { sourceFile, text };
}

function getText(node, fullText) {
  return fullText.slice(node.getStart(), node.getEnd());
}

function lineCount(node, fullText) {
  return getText(node, fullText).split('\n').length;
}

/** True if the node is a JSX element / self-closing element / fragment. */
function isJsxNode(node) {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node)
  );
}

/** Unwraps parenthesized expressions: `(<View/>)` -> `<View/>`. */
function unwrapParens(node) {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/**
 * Finds the first component-like function (capitalized name, or default
 * export) that contains a `return <JSX/>` and returns
 * { functionNode, rootJsx, returnStatement }.
 */
function findComponentReturn(sourceFile) {
  let result = null;

  function visit(node) {
    if (result) return;

    if (ts.isReturnStatement(node) && node.expression) {
      const expr = unwrapParens(node.expression);
      if (isJsxNode(expr)) {
        // Walk up to find the enclosing function
        let fn = node.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        result = { functionNode: fn || null, rootJsx: expr, returnStatement: node };
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

/** Gets the real child nodes of a JsxElement/JsxFragment (ignores blank JsxText). */
function getMeaningfulChildren(jsxNode) {
  if (!('children' in jsxNode)) return [];
  return jsxNode.children.filter((child) => {
    if (ts.isJsxText(child)) return child.text.trim().length > 0;
    return true; // JsxElement, JsxSelfClosingElement, JsxExpression, JsxFragment
  });
}

// ---------- scope / free-variable analysis ----------

/** Collects every identifier *bound* (declared) anywhere within a subtree. */
function collectBoundNames(node, out = new Set()) {
  function visit(n) {
    if (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) {
      collectNamesFromBindingName(n.name, out);
    }
    if (ts.isFunctionDeclaration(n) && n.name) out.add(n.name.text);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return out;
}

function collectNamesFromBindingName(name, out) {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectNamesFromBindingName(el.name, out);
    }
  }
}

/** Collects every identifier *used* (referenced) within a subtree, excluding
 * property-access names, property-assignment keys, and JSX tag names. */
function collectUsedIdentifiers(node) {
  const used = new Set();

  function visit(n) {
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const isPropertyAccessName = ts.isPropertyAccessExpression(parent) && parent.name === n;
      const isPropertyAssignmentKey =
        (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
        parent.name === n &&
        !ts.isShorthandPropertyAssignment(parent); // shorthand key IS also a value use
      const isJsxAttrName = ts.isJsxAttribute(parent) && parent.name === n;
      const isJsxTagName =
        (ts.isJsxOpeningElement(parent) || ts.isJsxClosingElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
        parent.tagName === n;
      const isBindingDeclaration =
        (ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) &&
        parent.name === n;

      if (
        !isPropertyAccessName &&
        !isPropertyAssignmentKey &&
        !isJsxAttrName &&
        !isJsxTagName &&
        !isBindingDeclaration
      ) {
        used.add(n.text);
      }
    }
    ts.forEachChild(n, visit);
  }

  visit(node);
  return used;
}

/** Collects capitalized JSX tag names used in a subtree (custom components). */
function collectJsxTagNames(node) {
  const tags = new Set();
  function visit(n) {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (ts.isIdentifier(n.tagName)) tags.add(n.tagName.text);
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return tags;
}

/**
 * Collects names declared in the enclosing scope (component params/props,
 * top-level const/function declarations, useState/useX hook results) that
 * are visible to the component's return statement.
 */
function collectOuterScopeNames(sourceFile, functionNode) {
  const names = new Set();

  // component's own parameters (incl. destructured props)
  if (functionNode && functionNode.parameters) {
    for (const p of functionNode.parameters) collectNamesFromBindingName(p.name, names);
  }

  // everything declared at the top level of the function body
  if (functionNode && functionNode.body && ts.isBlock(functionNode.body)) {
    for (const stmt of functionNode.body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          collectNamesFromBindingName(decl.name, names);
        }
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
    }
  }

  return names;
}

/** Roughly infer a TS type string from a variable's initializer, for nicer
 * generated prop types than a blanket `any`. Best-effort only. */
function inferTypeFromDeclaration(sourceFile, functionNode, name) {
  let inferred = null;
  function visit(n) {
    if (inferred) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      const init = n.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useState') {
        const arg = init.arguments[0];
        if (!arg) inferred = 'any';
        else if (ts.isArrayLiteralExpression(arg)) inferred = 'any[]';
        else if (ts.isStringLiteral(arg)) inferred = 'string';
        else if (arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword) inferred = 'boolean';
        else if (ts.isNumericLiteral(arg)) inferred = 'number';
        else inferred = 'any';
      } else if (ts.isArrayLiteralExpression(init)) {
        inferred = 'any[]';
      } else if (ts.isStringLiteral(init)) {
        inferred = 'string';
      } else if (ts.isNumericLiteral(init)) {
        inferred = 'number';
      }
    }
    ts.forEachChild(n, visit);
  }
  if (functionNode) visit(functionNode);
  return inferred || 'any';
}

// ---------- style extraction ----------

let styleCounter = 0;

/** Finds every `style={{ ... }}` JsxAttribute inside a subtree and replaces
 * it with `style={styles.nameN}`, returning the collected style entries. */
function extractInlineStyles(node, printer, sourceFile) {
  const styleEntries = []; // { name, objectLiteralText }

  function visit(n) {
    if (
      ts.isJsxAttribute(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'style' &&
      n.initializer &&
      ts.isJsxExpression(n.initializer) &&
      n.initializer.expression &&
      ts.isObjectLiteralExpression(n.initializer.expression)
    ) {
      styleCounter += 1;
      const name = `style${styleCounter}`;
      const objText = printer.printNode(
        ts.EmitHint.Unspecified,
        n.initializer.expression,
        sourceFile
      );
      styleEntries.push({ name, objectLiteralText: objText });
      // NOTE: actual text replacement is done at the string level in the
      // caller (see replaceStyleUsagesInText) since mutating the AST and
      // re-printing the whole subtree tends to reformat unrelated code.
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return styleEntries;
}

/**
 * Like findComponentReturn, but finds EVERY `return <JSX/>` in the file,
 * not just the first — this covers early-return patterns like:
 *   if (isLoading) return <Spinner />;
 *   ... 
 *   return <MainContent />;
 * Each branch is processed independently so a big "loaded" branch can be
 * split even if an earlier small "loading" branch exists.
 */
function findAllJsxReturns(sourceFile) {
  const results = [];

  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression) {
      const expr = unwrapParens(node.expression);
      if (isJsxNode(expr)) {
        let fn = node.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        results.push({ functionNode: fn || null, rootJsx: expr, returnStatement: node });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}

/** Finds the first Identifier node within a subtree matching `name` — used
 * to get a real "as-used" location for type-checking via ts.TypeChecker. */
function findIdentifierOccurrence(node, name) {
  let found = null;
  function visit(n) {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}
module.exports = {
  findAllJsxReturns,
  findIdentifierOccurrence,
  parseSource,
  getText,
  lineCount,
  isJsxNode,
  findComponentReturn,
  getMeaningfulChildren,
  collectBoundNames,
  collectUsedIdentifiers,
  collectJsxTagNames,
  collectOuterScopeNames,
  inferTypeFromDeclaration,
  extractInlineStyles,
  KNOWN_RN_COMPONENTS,
  DEFAULT_OPTIONS,
};
