import { describe, it, expect } from 'vitest'
import { parseEnvConfig } from '../env.js'

describe('Environment Variable Parser', () => {
  describe('parseEnvConfig', () => {
    it('returns empty object when no env vars set', () => {
      const result = parseEnvConfig({})
      expect(result).toEqual({})
    })

    it('parses string values', () => {
      const result = parseEnvConfig({
        OPENTASKS_STORAGE_JSONL_PATH: 'custom.jsonl',
        OPENTASKS_DAEMON_SOCKET_PATH: 'custom.sock',
      })
      expect(result.storage?.jsonlPath).toBe('custom.jsonl')
      expect(result.daemon?.socketPath).toBe('custom.sock')
    })

    it('parses boolean true values', () => {
      const resultTrue = parseEnvConfig({
        OPENTASKS_DAEMON_AUTO_START: 'true',
      })
      expect(resultTrue.daemon?.autoStart).toBe(true)

      const resultOne = parseEnvConfig({
        OPENTASKS_DAEMON_AUTO_START: '1',
      })
      expect(resultOne.daemon?.autoStart).toBe(true)

      const resultTrueUpper = parseEnvConfig({
        OPENTASKS_DAEMON_AUTO_START: 'TRUE',
      })
      expect(resultTrueUpper.daemon?.autoStart).toBe(true)
    })

    it('parses boolean false values', () => {
      const resultFalse = parseEnvConfig({
        OPENTASKS_DAEMON_AUTO_START: 'false',
      })
      expect(resultFalse.daemon?.autoStart).toBe(false)

      const resultZero = parseEnvConfig({
        OPENTASKS_DAEMON_AUTO_START: '0',
      })
      expect(resultZero.daemon?.autoStart).toBe(false)

      const resultFalseUpper = parseEnvConfig({
        OPENTASKS_DAEMON_AUTO_START: 'FALSE',
      })
      expect(resultFalseUpper.daemon?.autoStart).toBe(false)
    })

    it('parses numeric values', () => {
      const result = parseEnvConfig({
        OPENTASKS_STORAGE_AUTO_COMPACT_RATIO: '3.5',
        OPENTASKS_DAEMON_FLUSH_INTERVAL: '2000',
        OPENTASKS_PROVIDERS_BEADS_TIMEOUT: '45000',
      })
      expect(result.storage?.autoCompactRatio).toBe(3.5)
      expect(result.daemon?.flushInterval).toBe(2000)
      expect(result.providers?.beads?.timeout).toBe(45000)
    })

    it('parses null values (empty string)', () => {
      const result = parseEnvConfig({
        OPENTASKS_LOGGING_FILE: '',
      })
      expect(result.logging?.file).toBeNull()
    })

    it('parses null values (literal null)', () => {
      const result = parseEnvConfig({
        OPENTASKS_LOGGING_FILE: 'null',
      })
      expect(result.logging?.file).toBeNull()

      const resultNullUpper = parseEnvConfig({
        OPENTASKS_LOGGING_FILE: 'NULL',
      })
      expect(resultNullUpper.logging?.file).toBeNull()
    })

    it('parses logging file path', () => {
      const result = parseEnvConfig({
        OPENTASKS_LOGGING_FILE: 'logs/debug.log',
      })
      expect(result.logging?.file).toBe('logs/debug.log')
    })

    it('parses logging level', () => {
      const result = parseEnvConfig({
        OPENTASKS_LOGGING_LEVEL: 'debug',
      })
      expect(result.logging?.level).toBe('debug')
    })

    it('ignores unknown OPENTASKS_* variables', () => {
      const result = parseEnvConfig({
        OPENTASKS_UNKNOWN_SETTING: 'value',
        OPENTASKS_STORAGE_JSONL_PATH: 'test.jsonl',
      })
      expect(result.storage?.jsonlPath).toBe('test.jsonl')
      expect((result as Record<string, unknown>)['UNKNOWN_SETTING']).toBeUndefined()
    })

    it('ignores non-OPENTASKS variables', () => {
      const result = parseEnvConfig({
        PATH: '/usr/bin',
        HOME: '/home/user',
        OPENTASKS_LOGGING_LEVEL: 'warn',
      })
      expect(result.logging?.level).toBe('warn')
      expect((result as Record<string, unknown>)['PATH']).toBeUndefined()
    })

    it('handles nested provider config', () => {
      const result = parseEnvConfig({
        OPENTASKS_PROVIDERS_BEADS_ENABLED: 'false',
        OPENTASKS_PROVIDERS_BEADS_EXECUTABLE: '/opt/bd',
        OPENTASKS_PROVIDERS_CLAUDE_TASKS_ENABLED: 'true',
      })
      expect(result.providers?.beads?.enabled).toBe(false)
      expect(result.providers?.beads?.executable).toBe('/opt/bd')
      expect(result.providers?.claudeTasks?.enabled).toBe(true)
    })

    it('creates nested objects as needed', () => {
      const result = parseEnvConfig({
        OPENTASKS_PROVIDERS_BEADS_TIMEOUT: '60000',
      })
      expect(result.providers).toBeDefined()
      expect(result.providers?.beads).toBeDefined()
      expect(result.providers?.beads?.timeout).toBe(60000)
    })

    it('skips invalid numeric values silently', () => {
      const result = parseEnvConfig({
        OPENTASKS_DAEMON_FLUSH_INTERVAL: 'not-a-number',
        OPENTASKS_LOGGING_LEVEL: 'info',
      })
      expect(result.daemon?.flushInterval).toBeUndefined()
      expect(result.logging?.level).toBe('info')
    })

    it('only includes env vars that are set', () => {
      const result = parseEnvConfig({
        OPENTASKS_STORAGE_JSONL_PATH: 'test.jsonl',
      })
      expect(result.storage?.jsonlPath).toBe('test.jsonl')
      expect(result.storage?.sqlitePath).toBeUndefined()
      expect(result.daemon).toBeUndefined()
    })
  })
})
