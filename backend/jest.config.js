/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  // Suite is empty between Remote-mode rewrites; re-enable strict mode once
  // relay-server tests land.
  passWithNoTests: true,
};
