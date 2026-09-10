module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  testMatch: ["**/__tests__/**/*.unit.spec.ts"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
}
