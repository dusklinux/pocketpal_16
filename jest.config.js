module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  transform: {'^.+\\.[jt]sx?$': 'babel-jest'},
};
