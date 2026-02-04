import { describe, it, expect } from 'vitest'
import {
  OpenTasksConfigSchema,
  StorageConfigSchema,
  DaemonConfigSchema,
  BeadsProviderConfigSchema,
  ClaudeTasksProviderConfigSchema,
  ProvidersConfigSchema,
  LoggingConfigSchema,
  validateConfig,
  parseConfig,
  type OpenTasksConfig,
} from '../schema'

describe('Config Schema', () => {
  describe('StorageConfigSchema', () => {
    it('returns defaults for empty object', () => {
      const result = StorageConfigSchema.parse({})
      expect(result).toEqual({
        jsonlPath: 'graph.jsonl',
        sqlitePath: 'cache.db',
        autoCompactRatio: 2.0,
      })
    })

    it('accepts valid values', () => {
      const result = StorageConfigSchema.parse({
        jsonlPath: 'custom.jsonl',
        sqlitePath: 'custom.db',
        autoCompactRatio: 3.5,
      })
      expect(result.jsonlPath).toBe('custom.jsonl')
      expect(result.sqlitePath).toBe('custom.db')
      expect(result.autoCompactRatio).toBe(3.5)
    })

    it('rejects autoCompactRatio < 1', () => {
      expect(() => StorageConfigSchema.parse({ autoCompactRatio: 0.5 })).toThrow(
        'autoCompactRatio must be >= 1'
      )
    })

    it('accepts autoCompactRatio = 1', () => {
      const result = StorageConfigSchema.parse({ autoCompactRatio: 1 })
      expect(result.autoCompactRatio).toBe(1)
    })
  })

  describe('DaemonConfigSchema', () => {
    it('returns defaults for empty object', () => {
      const result = DaemonConfigSchema.parse({})
      expect(result).toEqual({
        socketPath: 'daemon.sock',
        autoStart: true,
        flushInterval: 1000,
      })
    })

    it('accepts valid values', () => {
      const result = DaemonConfigSchema.parse({
        socketPath: 'custom.sock',
        autoStart: false,
        flushInterval: 500,
      })
      expect(result.socketPath).toBe('custom.sock')
      expect(result.autoStart).toBe(false)
      expect(result.flushInterval).toBe(500)
    })

    it('rejects flushInterval < 100', () => {
      expect(() => DaemonConfigSchema.parse({ flushInterval: 50 })).toThrow(
        'flushInterval must be >= 100ms'
      )
    })

    it('accepts flushInterval = 100', () => {
      const result = DaemonConfigSchema.parse({ flushInterval: 100 })
      expect(result.flushInterval).toBe(100)
    })
  })

  describe('BeadsProviderConfigSchema', () => {
    it('returns defaults for empty object', () => {
      const result = BeadsProviderConfigSchema.parse({})
      expect(result).toEqual({
        enabled: true,
        executable: 'bd',
        timeout: 30000,
      })
    })

    it('accepts valid values', () => {
      const result = BeadsProviderConfigSchema.parse({
        enabled: false,
        executable: '/usr/local/bin/bd',
        timeout: 60000,
      })
      expect(result.enabled).toBe(false)
      expect(result.executable).toBe('/usr/local/bin/bd')
      expect(result.timeout).toBe(60000)
    })

    it('rejects timeout < 1000', () => {
      expect(() => BeadsProviderConfigSchema.parse({ timeout: 500 })).toThrow(
        'timeout must be >= 1000ms'
      )
    })

    it('accepts timeout = 1000', () => {
      const result = BeadsProviderConfigSchema.parse({ timeout: 1000 })
      expect(result.timeout).toBe(1000)
    })
  })

  describe('ClaudeTasksProviderConfigSchema', () => {
    it('returns defaults for empty object', () => {
      const result = ClaudeTasksProviderConfigSchema.parse({})
      expect(result).toEqual({
        enabled: true,
      })
    })

    it('accepts enabled = false', () => {
      const result = ClaudeTasksProviderConfigSchema.parse({ enabled: false })
      expect(result.enabled).toBe(false)
    })
  })

  describe('ProvidersConfigSchema', () => {
    it('returns defaults for empty object', () => {
      const result = ProvidersConfigSchema.parse({})
      expect(result).toEqual({
        beads: {
          enabled: true,
          executable: 'bd',
          timeout: 30000,
        },
        claudeTasks: {
          enabled: true,
        },
      })
    })

    it('accepts partial provider configs', () => {
      const result = ProvidersConfigSchema.parse({
        beads: { enabled: false },
      })
      expect(result.beads.enabled).toBe(false)
      expect(result.beads.executable).toBe('bd') // default
      expect(result.claudeTasks.enabled).toBe(true) // default
    })
  })

  describe('LoggingConfigSchema', () => {
    it('returns defaults for empty object', () => {
      const result = LoggingConfigSchema.parse({})
      expect(result).toEqual({
        level: 'info',
        file: null,
      })
    })

    it('accepts valid log levels', () => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        const result = LoggingConfigSchema.parse({ level })
        expect(result.level).toBe(level)
      }
    })

    it('rejects invalid log level', () => {
      expect(() => LoggingConfigSchema.parse({ level: 'verbose' })).toThrow()
    })

    it('accepts string file path', () => {
      const result = LoggingConfigSchema.parse({ file: 'logs/app.log' })
      expect(result.file).toBe('logs/app.log')
    })

    it('accepts null file', () => {
      const result = LoggingConfigSchema.parse({ file: null })
      expect(result.file).toBeNull()
    })

    it('accepts explicit null file', () => {
      const result = LoggingConfigSchema.parse({ file: null })
      expect(result.file).toBe(null)
    })
  })

  describe('OpenTasksConfigSchema', () => {
    it('returns full defaults for empty object', () => {
      const result = OpenTasksConfigSchema.parse({})
      expect(result).toEqual({
        storage: {
          jsonlPath: 'graph.jsonl',
          sqlitePath: 'cache.db',
          autoCompactRatio: 2.0,
        },
        daemon: {
          socketPath: 'daemon.sock',
          autoStart: true,
          flushInterval: 1000,
        },
        providers: {
          beads: {
            enabled: true,
            executable: 'bd',
            timeout: 30000,
          },
          claudeTasks: {
            enabled: true,
          },
        },
        logging: {
          level: 'info',
          file: null,
        },
      })
    })

    it('accepts partial config and fills defaults', () => {
      const result = OpenTasksConfigSchema.parse({
        storage: { jsonlPath: 'custom.jsonl' },
        logging: { level: 'debug' },
      })

      expect(result.storage.jsonlPath).toBe('custom.jsonl')
      expect(result.storage.sqlitePath).toBe('cache.db') // default
      expect(result.logging.level).toBe('debug')
      expect(result.daemon.autoStart).toBe(true) // default
    })

    it('preserves all provided values', () => {
      const config: OpenTasksConfig = {
        storage: {
          jsonlPath: 'data.jsonl',
          sqlitePath: 'data.db',
          autoCompactRatio: 1.5,
        },
        daemon: {
          socketPath: 'app.sock',
          autoStart: false,
          flushInterval: 2000,
        },
        providers: {
          beads: {
            enabled: false,
            executable: '/opt/bd',
            timeout: 45000,
          },
          claudeTasks: {
            enabled: false,
          },
        },
        logging: {
          level: 'error',
          file: 'logs/error.log',
        },
      }

      const result = OpenTasksConfigSchema.parse(config)
      expect(result).toEqual(config)
    })
  })

  describe('validateConfig', () => {
    it('returns success for valid config', () => {
      const result = validateConfig({})
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.errors).toBeUndefined()
    })

    it('returns success with parsed data', () => {
      const result = validateConfig({ logging: { level: 'debug' } })
      expect(result.success).toBe(true)
      expect(result.data?.logging.level).toBe('debug')
    })

    it('returns errors for invalid config', () => {
      const result = validateConfig({
        storage: { autoCompactRatio: 0 },
      })
      expect(result.success).toBe(false)
      expect(result.errors).toBeDefined()
      expect(result.errors?.length).toBeGreaterThan(0)
      expect(result.errors?.[0].path).toBe('storage.autoCompactRatio')
      expect(result.errors?.[0].message).toContain('autoCompactRatio must be >= 1')
    })

    it('returns multiple errors', () => {
      const result = validateConfig({
        storage: { autoCompactRatio: 0 },
        daemon: { flushInterval: 10 },
      })
      expect(result.success).toBe(false)
      expect(result.errors?.length).toBe(2)
    })

    it('provides clear error paths', () => {
      const result = validateConfig({
        providers: {
          beads: { timeout: 100 },
        },
      })
      expect(result.success).toBe(false)
      expect(result.errors?.[0].path).toBe('providers.beads.timeout')
    })
  })

  describe('parseConfig', () => {
    it('returns parsed config for valid input', () => {
      const result = parseConfig({})
      expect(result.storage.jsonlPath).toBe('graph.jsonl')
    })

    it('throws for invalid input', () => {
      expect(() =>
        parseConfig({
          logging: { level: 'invalid' },
        })
      ).toThrow()
    })
  })
})
