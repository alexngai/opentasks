import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadConfigFile } from '../loader'
import { ConfigParseError, ConfigValidationError } from '../errors'

describe('Config Loader', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-config-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  async function writeConfig(content: string): Promise<void> {
    const configDir = path.join(tempDir, '.opentasks')
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'config.json'), content)
  }

  describe('loadConfigFile', () => {
    it('returns null for missing config file', async () => {
      const result = await loadConfigFile(tempDir)
      expect(result).toBeNull()
    })

    it('returns null for missing .opentasks directory', async () => {
      const result = await loadConfigFile(tempDir)
      expect(result).toBeNull()
    })

    it('parses valid config file', async () => {
      await writeConfig(
        JSON.stringify({
          storage: { jsonlPath: 'custom.jsonl' },
          logging: { level: 'debug' },
        })
      )

      const result = await loadConfigFile(tempDir)
      expect(result).not.toBeNull()
      expect(result?.storage?.jsonlPath).toBe('custom.jsonl')
      expect(result?.logging?.level).toBe('debug')
    })

    it('handles partial config (not all fields)', async () => {
      await writeConfig(
        JSON.stringify({
          daemon: { autoStart: false },
        })
      )

      const result = await loadConfigFile(tempDir)
      expect(result).not.toBeNull()
      expect(result?.daemon?.autoStart).toBe(false)
      expect(result?.storage).toBeUndefined()
    })

    it('parses empty config object', async () => {
      await writeConfig('{}')

      const result = await loadConfigFile(tempDir)
      expect(result).not.toBeNull()
      expect(result).toEqual({})
    })

    it('throws ConfigParseError for invalid JSON', async () => {
      await writeConfig('{ invalid json }')

      await expect(loadConfigFile(tempDir)).rejects.toThrow(ConfigParseError)
    })

    it('throws ConfigParseError with file path', async () => {
      await writeConfig('not json at all')

      try {
        await loadConfigFile(tempDir)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigParseError)
        expect((err as ConfigParseError).filePath).toContain('config.json')
      }
    })

    it('throws ConfigValidationError for invalid values', async () => {
      await writeConfig(
        JSON.stringify({
          storage: { autoCompactRatio: 0.5 }, // Invalid: must be >= 1
        })
      )

      await expect(loadConfigFile(tempDir)).rejects.toThrow(ConfigValidationError)
    })

    it('throws ConfigValidationError with field paths', async () => {
      await writeConfig(
        JSON.stringify({
          daemon: { flushInterval: 10 }, // Invalid: must be >= 100
        })
      )

      try {
        await loadConfigFile(tempDir)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError)
        const validationErr = err as ConfigValidationError
        expect(validationErr.filePath).toContain('config.json')
        expect(validationErr.issues.length).toBeGreaterThan(0)
        expect(validationErr.issues[0].path).toContain('flushInterval')
      }
    })

    it('validates provider timeout constraint', async () => {
      await writeConfig(
        JSON.stringify({
          providers: {
            beads: { timeout: 500 }, // Invalid: must be >= 1000
          },
        })
      )

      await expect(loadConfigFile(tempDir)).rejects.toThrow(ConfigValidationError)
    })

    it('accepts valid logging level', async () => {
      await writeConfig(
        JSON.stringify({
          logging: { level: 'error' },
        })
      )

      const result = await loadConfigFile(tempDir)
      expect(result?.logging?.level).toBe('error')
    })

    it('rejects invalid logging level', async () => {
      await writeConfig(
        JSON.stringify({
          logging: { level: 'verbose' },
        })
      )

      await expect(loadConfigFile(tempDir)).rejects.toThrow(ConfigValidationError)
    })

    it('accepts null for logging.file', async () => {
      await writeConfig(
        JSON.stringify({
          logging: { file: null },
        })
      )

      const result = await loadConfigFile(tempDir)
      expect(result?.logging?.file).toBeNull()
    })

    it('accepts string for logging.file', async () => {
      await writeConfig(
        JSON.stringify({
          logging: { file: 'logs/app.log' },
        })
      )

      const result = await loadConfigFile(tempDir)
      expect(result?.logging?.file).toBe('logs/app.log')
    })
  })
})
