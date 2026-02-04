/**
 * Configuration error types
 */
import type { ZodIssue } from 'zod'

/**
 * Error thrown when config file contains invalid JSON
 */
export class ConfigParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly cause: Error
  ) {
    super(`Failed to parse config file: ${filePath}\n${cause.message}`)
    this.name = 'ConfigParseError'
  }
}

/**
 * Error thrown when config file contains invalid values
 */
export class ConfigValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly issues: ZodIssue[]
  ) {
    const issueMessages = issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    super(`Invalid config file: ${filePath}\n${issueMessages}`)
    this.name = 'ConfigValidationError'
  }
}
