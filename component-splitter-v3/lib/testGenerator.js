/**
 * Generates a minimal smoke-test stub for a newly extracted component.
 * This intentionally does NOT try to be a thorough test — it's a starting
 * point so extracted components aren't left with zero test coverage,
 * which was one of the original complaints this whole tool is meant to help with.
 *
 * Requires @testing-library/react-native to actually run — that's not
 * assumed to be installed, so the file is marked with a comment saying so,
 * and excluded from the self-check type-checking pass (its types would
 * otherwise fail if that library isn't present).
 */
function generateTestStub(componentName, props, relativeImportPath) {
  const mockProps = props
    .map((p) => {
      let mockValue = '"test"';
      if (p.type === 'number') mockValue = '0';
      else if (p.type === 'boolean') mockValue = 'false';
      else if (p.type.endsWith('[]')) mockValue = '[]';
      else if (p.type === 'any' || p.type.includes('=>')) mockValue = '(() => {}) as any';
      return `  ${p.name}: ${mockValue},`;
    })
    .join('\n');

  return `// @ts-nocheck
// NOTE: requires @testing-library/react-native to run:
//   npm install --save-dev @testing-library/react-native
// This is a starter smoke test, not full coverage — extend as needed.
import React from 'react';
import { render } from '@testing-library/react-native';
import ${componentName} from '${relativeImportPath}';

const mockProps = {
${mockProps}
};

test('${componentName} renders without crashing', () => {
  render(<${componentName} {...mockProps} />);
});
`;
}

module.exports = { generateTestStub };
